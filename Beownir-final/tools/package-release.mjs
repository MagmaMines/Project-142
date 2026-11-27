#!/usr/bin/env node
/** Build a reproducible, integrity-checked candidate bundle (not a public release). */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { root, verifyArtifact, ARTIFACT_NAME } from './build-standalone.mjs';

const outDir = path.resolve(process.argv[2] || path.join(root, 'dist', 'beownir-candidate'));
const artifactPath = path.join(root, ARTIFACT_NAME);
if (!fs.existsSync(artifactPath)) throw new Error('standalone artifact is missing; run npm run build:standalone');
const html = fs.readFileSync(artifactPath, 'utf8');
const { problems, manifest } = verifyArtifact(html);
if (problems.length) throw new Error('artifact failed verification:\n' + problems.map(x => ' - ' + x).join('\n'));
if (!manifest) throw new Error('artifact has no integrity manifest');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const digest = crypto.createHash('sha256').update(html).digest('hex');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'beownir-standalone.html'), html);
/* The headless embed client ships next to the IDE file: third-party pages load
 * it instead of the whole IDE (see EMBEDDING.md). */
const embedPath = path.join(root, 'o', 'embed', 'beownir-kernel.js');
if (!fs.existsSync(embedPath)) throw new Error('embed bundle is missing; run node tools/build-embed.mjs');
const embed = fs.readFileSync(embedPath);
fs.writeFileSync(path.join(outDir, 'beownir-kernel.js'), embed);
fs.writeFileSync(path.join(outDir, 'SHA256SUMS'), `${digest}  beownir-standalone.html\n${crypto.createHash('sha256').update(embed).digest('hex')}  beownir-kernel.js\n`);
fs.writeFileSync(path.join(outDir, 'CANDIDATE-STATUS.txt'), [
  `Product: ${pkg.name} ${pkg.version}`,
  `Artifact SHA-256: ${digest}`,
  `Manifest format: ${manifest.format}`,
  `Embedded sources: ${manifest.sources.length}`,
  '',
  'INTERNAL CANDIDATE ONLY — NOT CLEARED FOR COMMERCIAL DISTRIBUTION.',
  `Package metadata declares private=${Boolean(pkg.private)} and license=${pkg.license || 'UNSET'}.`,
  'Before public/commercial release, the product owner must choose and supply applicable product licensing, confirm third-party redistribution rights and notices, and complete browser compatibility sign-off.',
  'This package proves artifact integrity only; it is not a security certification or a claim of full Node.js compatibility.'
].join('\n') + '\n');
console.log(`verified candidate bundle: ${outDir}`);
console.log(`version ${pkg.version}; sha256 ${digest}`);
console.log('commercial release: BLOCKED until owner/legal and release gates are satisfied');
