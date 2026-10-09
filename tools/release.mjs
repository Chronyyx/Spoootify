#!/usr/bin/env node
/*
 * Publish a signed Spoootify release (publisher only — needs the private key + GitHub CLI).
 *
 *   node tools/release.mjs 1.1.0 "what changed"
 *
 * 1. sets version.json, builds dist/Spoootify.zip
 * 2. signs it with %USERPROFILE%\.spoootify\release-key.pem → dist/Spoootify.zip.sig
 * 3. commits, tags vX.Y.Z, pushes, and creates the GitHub release with both files
 * Every installed copy picks it up on its next boot (or within 6 h) and re-injects itself.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REPO, ASSET, PUBLIC_KEY } from './config.mjs';
import { compareVersions, verifySignature } from './update.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEY = path.join(os.homedir(), '.spoootify', 'release-key.pem');
const [version, notes = ''] = process.argv.slice(2);
const die = (m) => { console.error('✖ ' + m); process.exit(1); };
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit', ...opts });

if (!/^\d+\.\d+\.\d+$/.test(version || '')) die('usage: node tools/release.mjs <major.minor.patch> ["release notes"]');
if (!fs.existsSync(KEY)) die(`signing key not found at ${KEY} (run node tools/keygen.mjs once)`);
const priv = crypto.createPrivateKey(fs.readFileSync(KEY));
const derived = crypto.createPublicKey(priv).export({ type: 'spki', format: 'pem' }).trim();
if (derived !== PUBLIC_KEY.trim()) die('tools/config.mjs PUBLIC_KEY does not match your private key — installs would reject this release');

const vfile = path.join(ROOT, 'version.json');
const current = fs.existsSync(vfile) ? JSON.parse(fs.readFileSync(vfile, 'utf8')).version : '0.0.0';
const firstRelease = !execFileSync('git', ['tag', '--list', 'v*'], { cwd: ROOT, encoding: 'utf8' }).trim();
if (compareVersions(version, current) < 0 || (compareVersions(version, current) === 0 && !firstRelease)) {
  die(`version ${version} must be newer than ${current}`);
}
fs.writeFileSync(vfile, JSON.stringify({ version }, null, 2) + '\n');

sh(process.execPath, [path.join(ROOT, 'tools', 'package.mjs')]);
const zipPath = path.join(ROOT, 'dist', ASSET);
const zip = fs.readFileSync(zipPath);
const sig = crypto.sign(null, zip, priv).toString('base64');
if (!verifySignature(zip, sig)) die('signature self-check failed');
fs.writeFileSync(zipPath + '.sig', sig + '\n');
console.log('✔ signed ' + ASSET);

const tag = 'v' + version;
sh('git', ['add', '--', 'src', 'tools', 'install.bat', 'uninstall.bat', 'README.txt', 'BLUEPRINT.md', 'version.json', '.gitignore']);
try { sh('git', ['commit', '-m', `Release ${tag}`]); } catch { /* nothing to commit */ }
sh('git', ['tag', '-a', tag, '-m', `Spoootify ${tag}`]);
sh('git', ['push', '--follow-tags']);
sh('gh', ['release', 'create', tag, zipPath, zipPath + '.sig', '--repo', REPO, '--title', `Spoootify ${tag}`, '--notes',
  (notes ? notes + '\n\n' : '') + 'Install: download Spoootify.zip, unzip, double-click install.bat. Existing installs update themselves on next boot.']);
console.log(`✔ released ${tag} — installs update on their next boot (or within 6 h)`);
