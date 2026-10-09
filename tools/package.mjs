#!/usr/bin/env node
/* Build the shareable dist/Spoootify.zip (unzip → double-click install.bat). */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeEntry, writeZip } from './zip.mjs';
import { NAME, ASSET } from './config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILES = [
  'install.bat', 'uninstall.bat', 'README.txt', 'BLUEPRINT.md', 'version.json',
  'src/fluid-lyrics.js', 'src/fluid-lyrics.css', 'src/fl-engine.worker.js', 'src/fl-bg.worker.js',
  'tools/inject.mjs', 'tools/zip.mjs', 'tools/watch.mjs', 'tools/setup.mjs', 'tools/update.mjs', 'tools/config.mjs', 'tools/lyrics-proxy.mjs',
];
const entries = FILES.map((f) => {
  const p = path.join(ROOT, f);
  if (!fs.existsSync(p)) throw new Error('missing ' + f);
  return makeEntry(NAME + '/' + f, fs.readFileSync(p));
});
fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
const out = path.join(ROOT, 'dist', ASSET);
fs.writeFileSync(out, writeZip(entries));
console.log(`✔ ${out} (${(fs.statSync(out).size / 1024).toFixed(0)} KB, ${entries.length} files)`);
