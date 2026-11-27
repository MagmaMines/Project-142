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
  assert.equal((await run('echo a; echo b')).stdout, 'a\nb\n');
  assert.equal((await run('false; echo $?')).stdout, '1\n');
  assert.equal((await run('false && echo no; echo yes')).stdout, 'yes\n');
  assert.match((await run('ls --help')).stdout, /ls \[-laRh1\]/);
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

test('node, npm, and pnpm report parseable versions and compatibility notices', () => withScratch(async () => {
  assert.match((await run('node --version')).stdout, /^v\d+\.\d+\.\d+\n$/);
  assert.match((await run('node -v')).stdout, /^v\d+\.\d+\.\d+\n$/);
  assert.match((await run('npm --version')).stdout, /^\d+\.\d+\.\d+\n$/);
  assert.match((await run('pnpm --version')).stdout, /^\d+\.\d+\.\d+\n$/);
  assert.match((await run('which pnpm')).stdout, /\/usr\/bin\/pnpm/);
  assert.match((await run('node --beownir')).stdout, /not native Node\.js/);
  assert.match((await run('npm --beownir')).stdout, /not the npm executable/);
  assert.match((await run('pnpm --beownir')).stdout, /not the pnpm executable/);
  assert.match((await run('pnpm --help')).stdout, /pnpm install/);
  const origPkg = rt.CORE.fs.readFileSync('/project/package.json', 'utf8');
  try {
    rt.CORE.fs.writeFileSync('/project/package.json', JSON.stringify({ name: 'scratch', scripts: { test: 'node -e "console.log(19+23)"', greet: 'node -e "console.log(100+23)"' } }));
    const ran = await run('pnpm test');
    assert.equal(ran.code, 0);
    assert.match(ran.stdout, /(?:^|\n)42\r?\n/);
    const custom = await run('pnpm greet');
    assert.equal(custom.code, 0);
    assert.match(custom.stdout, /(?:^|\n)123\r?\n/);
  } finally {
    rt.CORE.fs.writeFileSync('/project/package.json', origPkg);
  }
  const execed = await run('pnpm exec node -e "console.log(21*2)"');
  assert.equal(execed.code, 0);
  assert.match(execed.stdout, /^42\b/);
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

test('quoting, escapes, per-stage redirections, and /dev/null work cleanly', () => withScratch(async () => {
  await run('export VAR=hi');
  assert.equal((await run('echo \'lit:\'"$VAR"')).stdout, 'lit:hi\n');
  assert.equal((await run('echo "$VAR"\':$HOME\'')).stdout, 'hi:$HOME\n');
  assert.equal((await run('echo "\\$VAR"')).stdout, '$VAR\n');
  assert.equal((await run('echo \\$VAR')).stdout, '$VAR\n');

  await run('echo alpha 1> /project/scratch/one.txt');
  assert.equal((await run('cat /project/scratch/one.txt')).stdout, 'alpha\n');
  await run('echo a2> /project/scratch/mid.txt');
  assert.equal((await run('cat /project/scratch/mid.txt')).stdout, 'a2\n');
  await run('export TARGET=/project/scratch/varout.txt && echo ok > "$TARGET"');
  assert.equal((await run('cat /project/scratch/varout.txt')).stdout, 'ok\n');
  await assert.rejects(run('echo x > "/project/scratch/unclosed'), /Unclosed quote/);

  assert.equal((await run('echo ignored > /dev/null')).stdout, '');
  assert.equal((await run('cat < /dev/null')).stdout, '');
  assert.equal((await run('false | echo after')).stdout, 'after\n');
  const errPipe = await run('cat /project/scratch/missing.txt 2>&1 | grep ENOENT');
  assert.equal(errPipe.code, 0);
  assert.match(errPipe.stdout, /ENOENT/);
  const suppressed = await run('cat /project/scratch/missing.txt 2>/dev/null | wc -l');
  assert.equal(suppressed.code, 0);
  assert.equal(suppressed.stderr, '');
  assert.equal(suppressed.stdout.trim(), '0');
}));

test('POSIX flags and edge cases across text/fs/process utilities work', () => withScratch(async () => {
  await run('mkdir -p /project/scratch/sub && cd /project/scratch/sub');
  const cdBack = await run('cd /project/scratch && cd -');
  assert.match(cdBack.stdout, /\/project\/scratch\/sub\n$/);
  assert.equal((await run('pwd')).stdout, '/project/scratch/sub\n');
  await run('cd /project');

  await run('touch /project/scratch/sub/x.txt /project/scratch/sub/y.txt');
  assert.equal((await run('ls -1 /project/scratch/sub')).stdout, 'x.txt\ny.txt\n');
  assert.match((await run('ls -lh /project/scratch/sub')).stdout, /0 B\s+.*x\.txt/);
  assert.match((await run('ls -R /project/scratch')).stdout, /\/project\/scratch\/sub:/);

  assert.equal((await run("printf 'one\\ntwo\\n' | cat -")).stdout, 'one\ntwo\n');
  assert.equal((await run("printf 'raw-no-nl' | cat")).stdout, 'raw-no-nl');
  assert.equal((await run("printf 'one\\ntwo\\n' | head -n 1 -")).stdout, 'one\n');
  assert.equal((await run("printf 'one\\ntwo\\n' | tail -n 1 -")).stdout, 'two\n');
  assert.equal((await run("printf 'a\\na\\nb\\n' | uniq -")).stdout, 'a\nb\n');

  assert.equal((await run("printf 'a.b\\naxb\\n' | grep -F a.b")).stdout, 'a.b\n');
  assert.equal((await run("printf 'foobar\\nfoo\\n' | grep -w foo")).stdout, 'foo\n');
  assert.equal((await run("printf 'hi\\n' | grep -q hi")).stdout, '');
  assert.equal((await run("printf 'hi\\n' | grep -q hi")).code, 0);
  assert.equal((await run("printf 'one\\ntwo\\nthree\\n' | grep -e one -e three")).stdout, 'one\nthree\n');

  await run("printf 'b' > /project/scratch/s1.txt && printf 'a' > /project/scratch/s2.txt");
  assert.equal((await run('sort /project/scratch/s1.txt /project/scratch/s2.txt')).stdout, 'a\nb\n');
  assert.equal((await run("printf '10\\nalpha\\n2\\n' | sort -n")).stdout, 'alpha\n2\n10\n');

  assert.equal((await run("printf 'a,b,c\\nd,e,f\\n' | cut -d, -f1,2")).stdout, 'a,b\nd,e\n');
  assert.equal((await run("printf 'a,b,c\\n' | cut -d, -f2-")).stdout, 'b,c\n');
  assert.equal((await run("printf 'a\\nb\\n' | tr '\\n' ','")).stdout, 'a,b,');

  assert.equal((await run("printf 'aaa\\n' | sed s/a/b/")).stdout, 'baa\n');
  assert.equal((await run("printf 'aaa\\n' | sed s/a/b/g")).stdout, 'bbb\n');
  assert.equal((await run("printf 'foo/bar\\n' | sed 's/foo\\/bar/baz\\/qux/'")).stdout, 'baz/qux\n');
  assert.equal((await run("printf 'k=9\\n' | sed 's/(k)=([0-9])/\\2:\\1/'")).stdout, '9:k\n');
  assert.equal((await run("printf 'abc\\n' | sed -e s/a/x/ -e s/c/z/")).stdout, 'xbz\n');

  await run("printf 'first\\n' > /project/scratch/f1.txt && printf 'second\\n' > /project/scratch/f2.txt");
  await run('sed -i s/first/FIRST/ /project/scratch/f1.txt /project/scratch/f2.txt');
  assert.equal((await run('cat /project/scratch/f1.txt')).stdout, 'FIRST\n');
  assert.equal((await run('cat /project/scratch/f2.txt')).stdout, 'second\n');

  assert.match((await run('du -a /project/scratch')).stdout, /f1\.txt/);
  assert.equal((await run('echo hello -n')).stdout, 'hello -n\n');
  assert.equal((await run("echo -e '\\\\n'")).stdout, '\\n\n');
  assert.equal((await run("printf '%-4s %03d\\n' a 7 b 12")).stdout, 'a    007\nb    012\n');

  assert.equal((await run('test hello')).code, 0);
  assert.equal((await run('test ! -f /project/scratch/missing')).code, 0);
  assert.equal((await run('test -L /project/scratch/missing')).code, 1);
  await run('ln -s /project/scratch/f1.txt /project/scratch/f1.link');
  assert.equal((await run('test -L /project/scratch/f1.link')).code, 0);
  await assert.rejects(run('[ -f /project/scratch/f1.txt ] ]'), /too many arguments/);
  await assert.rejects(run('[ -f /project/scratch/f1.txt'), /missing closing/);
  assert.equal((await run("time echo '*'")).stdout, '*\n');

  assert.equal((await run('ports')).stdout, '(no listening ports)\n');
  assert.equal((await run('kill -0 123')).code, 0);
  const opened = await run('open http://localhost:5173/app');
  assert.ok(opened.messages.some(m => m.type === 'open' && m.port === 5173));
  assert.doesNotMatch((await run('help all')).stdout, /No HMR|bounded Node-API/);
}));

test('curl fetches virtual loopback servers with methods, repeated headers and -I', () => withScratch(async () => {
  const srv = rt.serveRemote(4123, req => ({
    status: 200,
    headers: { 'content-type': 'application/json', 'x-seen-method': req.method },
    body: Buffer.from(JSON.stringify({ url: req.url, h1: req.headers['x-one'], h2: req.headers['x-two'], body: req.body ? req.body.toString() : null })),
  }));
  try {
    const getRes = await run('curl http://127.0.0.1:4123/hello');
    assert.equal(getRes.code, 0);
    assert.equal(JSON.parse(getRes.stdout).url, '/hello');

    const headRes = await run('curl -I http://localhost:4123/hello');
    assert.equal(headRes.code, 0);
    assert.match(headRes.stdout, /HTTP 200/);
    assert.match(headRes.stdout, /x-seen-method:\s*HEAD/i);

    const postRes = await run('curl -X POST -H "X-One: alpha" -H "X-Two: beta" -d "{\\"ok\\":true}" http://127.0.0.1:4123/submit');
    assert.equal(postRes.code, 0);
    const parsed = JSON.parse(postRes.stdout);
    assert.equal(parsed.h1, 'alpha');
    assert.equal(parsed.h2, 'beta');
    assert.equal(parsed.body, '{"ok":true}');

    const saved = await run('curl -s -o /project/scratch/resp.json http://127.0.0.1:4123/saved');
    assert.equal(saved.code, 0);
    assert.equal(saved.stdout, '');
    assert.equal(JSON.parse((await run('cat /project/scratch/resp.json')).stdout).url, '/saved');
  } finally {
    srv.close();
  }
}));
