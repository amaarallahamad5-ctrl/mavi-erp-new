#!/usr/bin/env node
'use strict';
// Read-only recovery of public, pinned assets. Never upload project or customer data.
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const base = 'https://raw.githubusercontent.com/amaarallahamad5-ctrl/mavi-erp-new/f6c79a31f01d18604153f4a106d8dd130914acf0/public/store/colour/';
const files = [
  ['model.part0', '4635c98a7c44febad8f77ea4a4f899745cb281a07e17950ab79166ca76f1a4f9'],
  ['model.part1', 'fe0b69a3fdbc8808fcaf764685791dc7c2a59383451709be3c7f885ae852df6e'],
  ['model.part2', '551af0dcadf17ca94c78bbff2f3cfd5837f0bb37b72071ff13231f7461dbb834'],
  ['ort-wasm-simd-threaded.wasm', '06b3f98e5aa2fffec1e3ac57a48bf1073828c6624e14d210750bc596c2e35d65']
];
const dir = path.resolve(__dirname, '..', 'public', 'store', 'colour');
async function sha256(file) {
  const h = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) h.update(chunk);
  return h.digest('hex');
}
async function exists(file) {
  try { await fsp.access(file); return true; }
  catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}
async function restore(name, expected) {
  const dest = path.join(dir, name);
  if (await exists(dest)) {
    if (await sha256(dest) !== expected) throw new Error(`${name} already exists with a different hash; it was not changed.`);
    console.log(`Already present and verified: ${name}`); return;
  }
  const tmp = path.join(dir, `.${name}.${crypto.randomBytes(8).toString('hex')}.download`);
  try {
    console.log(`Downloading public asset ${name}...`);
    const res = await fetch(base + encodeURIComponent(name), { signal: AbortSignal.timeout(180000) });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} while downloading ${name}`);
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp, { flags: 'wx', mode: 0o600 }));
    if (await sha256(tmp) !== expected) throw new Error(`SHA-256 verification failed for ${name}; file not installed.`);
    try { await fsp.link(tmp, dest); }
    catch (err) {
      if (err.code === 'EEXIST') {
        if (await sha256(dest) !== expected) throw new Error(`${name} appeared with a different hash; it was not changed.`);
      } else if (['EPERM','ENOTSUP','EXDEV','ENOSYS'].includes(err.code)) {
        await fsp.copyFile(tmp, dest, fs.constants.COPYFILE_EXCL);
      } else throw err;
    }
    console.log(`Verified: ${name}`);
  } finally { await fsp.unlink(tmp).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
}
(async () => {
  if (typeof fetch !== 'function') throw new Error('Node.js 18 or newer is required.');
  await fsp.mkdir(dir, { recursive: true });
  for (const [name, expected] of files) await restore(name, expected);
  console.log('Done. All four public colour assets are present and verified.');
})().catch(err => { console.error(`Restore failed: ${err.message}`); process.exitCode = 1; });
