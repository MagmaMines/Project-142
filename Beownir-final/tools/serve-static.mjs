#!/usr/bin/env node
/* Serves o/site exactly the way the Netlify deploy does: same files, same
 * headers, read from the repository's netlify.toml. `npm run serve:static`
 * opens http://localhost:8080 with cross-origin isolation enabled, which is the
 * environment the single file is designed for. */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const configFile = path.join(root, 'netlify.toml');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

const unquote = value => {
  const text = value.trim();
  const quote = text[0];
  if ((quote === '"' || quote === "'") && text.endsWith(quote)) return text.slice(1, -1);
  throw new Error('unsupported TOML value: ' + text);
};

/* A deliberately small reader for the subset of TOML this repository uses:
 * `[build]` with `publish =`, and `[[headers]]` blocks with `for =` plus a
 * `[headers.values]` table. Unknown keys are rejected so a typo in netlify.toml
 * fails here instead of silently deploying without a header. */
export function parseConfig(text) {
  const config = { publish: null, command: null, environment: {}, headers: [] };
  let section = null;
  let current = null;
  for (const raw of String(text).split('\n')) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    if (!line || line.startsWith('#')) continue;
    if (line === '[build]') { section = 'build'; current = null; continue; }
    if (line === '[build.environment]') { section = 'environment'; current = null; continue; }
    if (line === '[[headers]]') { section = 'headers'; current = { for: null, values: {} }; config.headers.push(current); continue; }
    if (line === '[headers.values]') {
      if (!current) throw new Error('[headers.values] without a [[headers]] block');
      section = 'values';
      continue;
    }
    const equals = line.indexOf('=');
    if (equals < 0) throw new Error('unsupported line in netlify.toml: ' + line);
    const key = line.slice(0, equals).trim();
    const value = unquote(line.slice(equals + 1));
    if (section === 'build') {
      if (key === 'publish') config.publish = value;
      else if (key === 'command') config.command = value;
      else throw new Error('unsupported [build] key: ' + key);
    } else if (section === 'environment') {
      config.environment[key] = value;
    } else if (section === 'headers') {
      if (key !== 'for') throw new Error('unsupported [[headers]] key: ' + key);
      current.for = value;
    } else if (section === 'values') {
      current.values[key] = value;
    } else {
      throw new Error('key outside a section: ' + key);
    }
  }
  for (const block of config.headers) {
    if (!block.for) throw new Error('[[headers]] block without `for`');
  }
  return config;
}

/** Netlify's `for` patterns that this deploy uses: `/*` and exact paths. */
export function matches(pattern, pathname) {
  if (pattern === '/*') return true;
  if (pattern.endsWith('/*')) return pathname.startsWith(pattern.slice(0, -1));
  return pattern === pathname;
}

export function headersFor(config, pathname) {
  const headers = {};
  for (const block of config.headers) {
    if (!matches(block.for, pathname)) continue;
    Object.assign(headers, block.values);
  }
  return headers;
}

export function createServer({ site = path.join(root, 'o', 'site'), config = parseConfig(fs.readFileSync(configFile, 'utf8')) } = {}) {
  const siteRoot = path.resolve(site);
  return http.createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://localhost');
    let pathname = decodeURIComponent(url.pathname);
    if (pathname.endsWith('/')) pathname += 'index.html';
    const file = path.resolve(siteRoot, '.' + pathname);
    // A static server must never serve outside its publish directory.
    if (file !== siteRoot && !file.startsWith(siteRoot + path.sep)) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Not found\n');
      return;
    }
    let stat;
    try { stat = fs.statSync(file); } catch { stat = null; }
    if (stat && stat.isDirectory()) { response.writeHead(302, { location: pathname + '/' }); response.end(); return; }
    if (!stat) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', ...headersFor(config, pathname) });
      response.end('Not found\n');
      return;
    }
    const headers = {
      'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
      'content-length': String(stat.size),
      ...headersFor(config, pathname),
    };
    response.writeHead(200, headers);
    if (request.method === 'HEAD') { response.end(); return; }
    fs.createReadStream(file).pipe(response);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const config = parseConfig(fs.readFileSync(configFile, 'utf8'));
  const site = path.join(root, config.publish || 'o/site');
  if (!fs.existsSync(path.join(site, 'index.html'))) {
    console.error('publish directory has no index.html: ' + site);
    process.exit(1);
  }
  const port = Number(process.env.PORT || process.argv[2] || 8080);
  const server = createServer({ site, config });
  server.listen(port, '0.0.0.0', () => {
    console.log('Beownir single file on http://localhost:' + port + '/  (publish ' + path.relative(root, site) + ')');
    console.log('Cross-origin isolation: ' + ['Cross-Origin-Opener-Policy', 'Cross-Origin-Embedder-Policy']
      .map(name => name + '=' + (headersFor(config, '/')[name] || 'missing')).join(' '));
  });
}
