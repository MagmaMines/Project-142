import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRuntime } from './helpers/runtime.mjs';

/* Exercises the virtual shell through the real worker runtime: quoting,
 * expansion, redirection, pipelines and the filesystem commands that used to
 * mis-parse their arguments. */

const rt = loadRuntime();
const run = line => rt.run(line);

async function withScratch(fn) {
  rt.restore();
  await run('mkdir -p /project/scratch');
  try { await fn(); } finally { rt.restore(); }
}

test('shell quoting preserves spaces and single-quoted literals', () => withScratch(async () => {
  assert.equal((await run('echo "a   b"')).stdout, 'a   b\n');
  assert.equal((await run("echo 'x $HOME y'")).stdout, 'x $HOME y\n');
  assert.equal((await run('echo a\\ b')).stdout, 'a b\n');
  assert.equal((await run('echo -n no-newline')).stdout, 'no-newline');
  assert.equal((await run("echo -e 'a\\tb'")).stdout, 'a\tb\n');
}));

test('shell expands variables and honours NAME=value prefixes', () => withScratch(async () => {
  assert.equal((await run('export GREETING=hello && echo "$GREETING"')).stdout, 'hello\n');
  assert.equal((await run('export GREETING=hello && echo \'$GREETING\'')).stdout, '$GREETING\n');
  const prefixed = await run('PREFIX_ONLY=42 env | grep PREFIX_ONLY');
  assert.match(prefixed.stdout, /PREFIX_ONLY=42/);
  assert.equal((await run('env | grep PREFIX_ONLY')).code, 1, 'the prefix must not leak into the shell environment');
  await assert.rejects(run('export MISSING'), /Usage: export/, 'export without a value reports an error instead of storing "undefined"');
  await run('export DEFINED=value');
  assert.match((await run('export')).stdout, /declare -x DEFINED="value"/);
}));

test('shell redirects stdout, stderr and stdin', () => withScratch(async () => {
  await run('echo first > /project/scratch/a.txt');
  await run('echo second >> /project/scratch/a.txt');
  assert.equal((await run('cat /project/scratch/a.txt')).stdout, 'first\nsecond\n');
  assert.equal((await run('cat < /project/scratch/a.txt')).stdout, 'first\nsecond\n');

  const missing = await run('cat /project/scratch/nope.txt 2> /project/scratch/err.txt');
  assert.equal(missing.code, 1);
  assert.equal(missing.stderr, '', 'stderr was redirected into the file');
  assert.match((await run('cat /project/scratch/err.txt')).stdout, /ENOENT/);

  await run('echo both &> /project/scratch/both.txt');
  assert.equal((await run('cat /project/scratch/both.txt')).stdout, 'both\n');

  const missingParent = await run('echo x > /project/scratch/absent/out.txt');
  assert.notEqual(missingParent.code, 0, 'writing into a missing directory fails');
}));

test('shell pipelines connect commands', () => withScratch(async () => {
  assert.equal((await run("printf 'c\\nb\\na\\n' | sort")).stdout, 'a\nb\nc\n');
  assert.equal((await run("printf 'a\\nb\\nc\\n' | head -n 2")).stdout, 'a\nb\n');
  assert.equal((await run("printf 'a\\nb\\nc\\n' | tail -n 1")).stdout, 'c\n');
  assert.equal((await run("printf 'x\\ny\\nz\\n' | grep -c y")).stdout.trim(), '1');
  assert.equal((await run("printf 'a b c\\n' | wc -w")).stdout.trim(), '3');
  assert.equal((await run("printf 'b\\na\\nb\\n' | uniq")).stdout, 'b\na\nb\n');
  assert.equal((await run("printf 'b\\na\\nb\\n' | sort | uniq -c")).stdout.trim().split('\n').length, 2);
  assert.equal((await run("printf 'one two\\n' | sed s/two/2/")).stdout, 'one 2\n');
  assert.equal((await run("printf '1,2\\n' | cut -d , -f 2")).stdout.trim(), '2');
  assert.equal((await run("printf 'abc\\n' | tr a-z A-Z")).stdout, 'ABC\n');
  assert.equal((await run("printf 'hi\\n' | tee /project/scratch/tee.txt")).stdout, 'hi\n');
  assert.equal((await run('cat /project/scratch/tee.txt')).stdout, 'hi\n');
  assert.deepEqual((await run("printf 'a b c\\n' | xargs -n 2 echo")).stdout, 'a b\nc\n');
}));

test('ls accepts files, directories and flags', () => withScratch(async () => {
  await run('mkdir -p /project/scratch/dir && touch /project/scratch/dir/file.txt');
  const file = await run('ls /project/scratch/dir/file.txt');
  assert.equal(file.code, 0);
  assert.match(file.stdout, /file\.txt/);
  const list = await run('ls -l /project/scratch/dir');
  assert.match(list.stdout, /-rw-r--r--/);
  await assert.rejects(run('ls /project/scratch/nope'), /ENOENT/);
}));

test('rm and rmdir require the right flags', () => withScratch(async () => {
  await run('mkdir -p /project/scratch/dir && touch /project/scratch/dir/file.txt');
  await assert.rejects(run('rm /project/scratch/dir'), /without -r/);
  assert.equal((await run('rm /project/scratch/dir/file.txt')).code, 0);
  assert.equal((await run('rmdir /project/scratch/dir')).code, 0);
  await assert.rejects(run('rm /project'), /Refusing to remove/);
  await run('mkdir -p /project/scratch/deep/nested && touch /project/scratch/deep/nested/file.js');
  await run('rm -rf /project/scratch/deep');
  assert.equal((await run('ls /project/scratch')).code, 0);
  assert.match((await run('ls /project/scratch')).stdout + JSON.stringify(rt.FS), /scratch/);
  assert.equal(rt.FS['/project/scratch/deep'], undefined);
}));

test('cp and mv handle directories and existing targets', () => withScratch(async () => {
  await run('mkdir -p /project/scratch/src/nested && echo one > /project/scratch/src/a.txt && echo two > /project/scratch/src/nested/b.txt');
  await assert.rejects(run('cp /project/scratch/src /project/scratch/copy'), /without -r/);
  await run('cp -r /project/scratch/src /project/scratch/copy');
  assert.equal((await run('cat /project/scratch/copy/nested/b.txt')).stdout, 'two\n');
  await run('cp /project/scratch/src/a.txt /project/scratch/copy');
  assert.equal((await run('cat /project/scratch/copy/a.txt')).stdout, 'one\n');

  await run('echo old > /project/scratch/target.txt && echo new > /project/scratch/source.txt');
  await run('mv /project/scratch/source.txt /project/scratch/target.txt');
  assert.equal((await run('cat /project/scratch/target.txt')).stdout, 'new\n');
  assert.equal(rt.FS['/project/scratch/source.txt'], undefined);
}));

test('text utilities keep their documented semantics', () => withScratch(async () => {
  await run("printf 'alpha\\nbeta\\ngamma\\ndelta\\n' > /project/scratch/words.txt");
  assert.equal((await run('grep -n beta /project/scratch/words.txt')).stdout, '2:beta\n');
  assert.equal((await run('grep -v -c a /project/scratch/words.txt')).stdout.trim(), '0');
  assert.equal((await run('grep -l a /project/scratch/words.txt')).stdout, '/project/scratch/words.txt\n');
  assert.equal((await run('grep zzz /project/scratch/words.txt')).code, 1);
  assert.equal((await run('wc -l /project/scratch/words.txt')).stdout.trim(), '4 /project/scratch/words.txt');
  assert.equal((await run('head -2 /project/scratch/words.txt')).stdout, 'alpha\nbeta\n');
  assert.equal((await run('tail -n1 /project/scratch/words.txt')).stdout, 'delta\n');
  assert.equal((await run('sort -r /project/scratch/words.txt')).stdout, 'gamma\ndelta\nbeta\nalpha\n');
}));

test('find, stat, du, df and storage report the workspace', () => withScratch(async () => {
  await run('mkdir -p /project/scratch/src && touch /project/scratch/src/index.js');
  const found = await run("find /project/scratch -name '*.js' -type f");
  assert.equal(found.code, 0);
  assert.match(found.stdout, /\/project\/scratch\/src\/index\.js/);
  assert.match((await run('stat /project/scratch/src/index.js')).stdout, /regular file/);
  assert.match((await run('du -s /project/scratch')).stdout, /\/project\/scratch/);
  const df = await run('df');
  assert.match(df.stdout, /Workspace/);
  const storage = await run('storage gc');
  assert.ok(storage.messages.some(message => message.type === 'storage-gc-request'), 'storage gc asks the host to free space');
  assert.match(storage.stdout, /Freeing rebuildable storage/);
}));

test('shell helper commands behave like their POSIX counterparts', () => withScratch(async () => {
  assert.equal((await run('basename /a/b/c.js .js')).stdout, 'c\n');
  assert.equal((await run('dirname /a/b/c.js')).stdout, '/a/b\n');
  assert.equal((await run('realpath /project/package.json')).stdout, '/project/package.json\n');
  assert.equal((await run("printf '%s-%d\\n' name 7")).stdout, 'name-7\n');
  assert.match((await run('date +%Y')).stdout, /^\d{4}\n$/);
  assert.equal((await run('test -d /project')).code, 0);
  assert.equal((await run('test -f /project/package.json')).code, 0);
  assert.equal((await run('[ -f /project/missing.json ]')).code, 1);
  assert.equal((await run('test 1 -lt 2')).code, 0);
  assert.equal((await run('true')).code, 0);
  assert.equal((await run('false')).code, 1);
  assert.match((await run('which node')).stdout, /\/usr\/bin\/node/);
  assert.equal((await run('which nowhere')).code, 1);
}));

test('unknown commands and bad usage fail with helpful messages', () => withScratch(async () => {
  await assert.rejects(run('gti status'), /Unknown command: gti/);
  await assert.rejects(run('curl --head'), /Usage: curl/);
  await assert.rejects(run('printf'), /Usage: printf/);
  await assert.rejects(run('echo "unclosed'), /Unclosed quote/);
  await assert.rejects(run('echo a; echo b'), /Semicolon command lists are not supported/);
  assert.match((await run('ls --help')).stdout, /ls \[-la\]/);
  assert.match((await run('help')).stdout, /Beownir shell/);
}));

test('stream duplication and line counts match the POSIX behaviour', () => withScratch(async () => {
  const merged = await run('cat /project/scratch/missing.txt 2>&1');
  assert.equal(merged.code, 1);
  assert.match(merged.stdout, /ENOENT/, '2>&1 sends the error to stdout');
  assert.equal(merged.stderr, '', 'nothing is left on stderr');

  await run('cat /project/scratch/missing.txt 2> /project/scratch/err.txt');
  assert.match((await run('cat /project/scratch/err.txt')).stdout, /ENOENT/);

  const hidden = await run('echo to-stderr 1>&2');
  assert.equal(hidden.stdout, '');
  assert.match(hidden.stderr, /to-stderr/);

  assert.equal((await run("printf 'a\\nb\\n' | head -n 0")).stdout, '');
  assert.equal((await run("printf 'a\\nb\\n' | tail -n 0")).stdout, '');
  assert.equal((await run("printf 'a\\nb\\n' | head -n 1")).stdout, 'a\n');
  const negative = await run("printf 'a\\n' | head -n -1");
  assert.equal(negative.code, 1, 'a negative count fails the stage without killing the shell');
  assert.match(negative.stderr, /0 or more/);
}));

test('&& and || short-circuit while $? follows the last command', () => withScratch(async () => {
  assert.equal((await run('true || echo skipped')).stdout, '');
  assert.equal((await run('false || echo recovered')).stdout, 'recovered\n');
  assert.equal((await run('true && echo ran')).stdout, 'ran\n');
  assert.equal((await run('false && echo skipped')).code, 1);
  assert.equal((await run('false && echo no || echo fallback')).stdout, 'fallback\n');
  assert.equal((await run('false || echo status=$?')).stdout, 'status=1\n');
  assert.equal((await run('true && echo status=$?')).stdout, 'status=0\n');
}));

test('recursive grep skips dependency stores unless --all is given', () => withScratch(async () => {
  await run('mkdir -p /project/node_modules/pkg /project/src');
  await run('echo needle > /project/node_modules/pkg/index.js');
  await run('echo needle > /project/src/app.js');
  const filtered = await run('grep -rl needle /project');
  assert.match(filtered.stdout, /\/project\/src\/app\.js/);
  assert.doesNotMatch(filtered.stdout, /node_modules/);
  const everything = await run('grep -rl --all needle /project');
  assert.match(everything.stdout, /node_modules\/pkg\/index\.js/);
}));

test('node and npm report parseable versions', () => withScratch(async () => {
  assert.match((await run('node --version')).stdout, /^v\d+\.\d+\.\d+\n$/);
  assert.match((await run('node -v')).stdout, /^v\d+\.\d+\.\d+\n$/);
  assert.match((await run('npm --version')).stdout, /^\d+\.\d+\.\d+\n$/);
  assert.match((await run('node --beownir')).stdout, /not native Node\.js/);
  assert.match((await run('npm --beownir')).stdout, /not the npm executable/);
}));

test('du reports files as well as directories', () => withScratch(async () => {
  await run('echo hello > /project/scratch/sized.txt');
  const file = await run('du /project/scratch/sized.txt');
  assert.equal(file.code, 0);
  assert.match(file.stdout, /sized\.txt/);
  assert.match(file.stdout, /\b6\b/, 'du reports the UTF-8 byte size of the file');
  const directory = await run('du -s /project/scratch');
  assert.match(directory.stdout, /\/project\/scratch/);
}));

test('the root directory is reachable from the shell', () => withScratch(async () => {
  assert.equal((await run('cd / && pwd')).stdout, '/\n');
  assert.match((await run('ls /')).stdout, /project/);
  assert.equal((await run('cd ~ && pwd')).stdout, '/\n');
}));

test('history records executed commands', () => withScratch(async () => {
  await run('echo one');
  await run('echo two');
  const history = await run('history');
  assert.match(history.stdout, /echo one/);
  assert.match(history.stdout, /history/);
}));

test('runCommand reports the exit code through the worker protocol', async () => {
  rt.restore();
  const from = rt.posts.length;
  await rt.evaluate('runCommand("echo protocol", 42)');
  const messages = rt.posts.slice(from);
  const done = messages.find(message => message.type === 'done');
  assert.ok(done, 'a done message is posted');
  assert.equal(done.id, 42);
  assert.equal(done.code, 0);
  assert.ok(messages.some(message => message.type === 'stdout' && /protocol/.test(message.data)));
});
