// JavaScript stand-in for @tailwindcss/oxide's Scanner: the same contract Tailwind v4's
// PostCSS plugin uses (new Scanner({ sources }), scan(), files, globs), implemented
// with plain file reads. Candidates are every token-like run of source text; Tailwind
// itself then keeps only the ones that compile to real utilities.
const fs = require('fs');
const path = require('path');
const SKIP = new Set(['node_modules', '.git', 'dist', '.next', '.nuxt', '.svelte-kit', '.cache']);
const TOKEN = /[^\s"'`<>=;,\\{}]+/g;
function* walk(dir) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}
function globToRegex(pattern) {
  const body = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\/?/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '(?:.*/)?').replace(/\?/g, '[^/]');
  return new RegExp('^' + body + '$');
}
class Scanner {
  constructor({ sources = [] } = {}) {
    this.sources = sources;
    this.files = [];
    this.globs = [];
  }
  scan() {
    const candidates = new Set();
    const files = new Set();
    for (const source of this.sources) {
      if (source.negated) continue;
      const base = source.base || process.cwd();
      // '' and '*' mean every file below base (Oxide's auto-detection); other patterns are globs.
      const pattern = source.pattern && source.pattern !== '' && source.pattern !== '*' && source.pattern !== '**' && source.pattern !== '**/*' ? globToRegex(source.pattern) : null;
      for (const file of walk(base)) {
        const relative = path.relative(base, file);
        if (pattern && !pattern.test(relative)) continue;
        if (!pattern && !/\.(html|js|jsx|ts|tsx|vue|svelte|astro|md|mdx|mjs|cjs|php|twig|erb)$/i.test(file)) continue;
        let text;
        try { if (fs.statSync(file).size > 2 * 1024 * 1024) continue; text = fs.readFileSync(file, 'utf8'); } catch { continue; }
        files.add(file);
        for (const match of text.matchAll(TOKEN)) candidates.add(match[0]);
      }
    }
    this.files = [...files];
    return [...candidates];
  }
}
module.exports = { Scanner };
