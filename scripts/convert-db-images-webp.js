#!/usr/bin/env node
'use strict';
// Safely converts existing non-WebP catalogue images in SQLite (style_images) to WebP
// using cwebp or ffmpeg when available, keeping rows untouched unless smaller.
// Usage: node scripts/convert-db-images-webp.js [--dry-run] [--db path/to/mavi.db]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const dbIdx = args.indexOf('--db');
const dbPath = dbIdx !== -1 && args[dbIdx + 1]
  ? path.resolve(args[dbIdx + 1])
  : path.resolve(process.env.DB_PATH || path.join(__dirname, '..', 'data', 'mavi.db'));

function hasTool(name) {
  return spawnSync(name, ['-version'], { stdio: 'ignore' }).status === 0;
}

const useCwebp = hasTool('cwebp');
const useFfmpeg = !useCwebp && hasTool('ffmpeg');
if (!useCwebp && !useFfmpeg) {
  console.error('Neither cwebp nor ffmpeg is installed on this host.');
  process.exit(1);
}

if (!fs.existsSync(dbPath)) {
  console.error('Database not found:', dbPath);
  process.exit(1);
}

const db = new Database(dbPath, { readonly: dryRun });
const rows = db.prepare("SELECT id, style_id, image, image_type FROM style_images WHERE image_type != 'image/webp' ORDER BY id").all();
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mavi-webp-'));
let totalBefore = 0;
let totalAfter = 0;
let converted = 0;

try {
  const update = dryRun ? null : db.prepare('UPDATE style_images SET image = ?, image_type = ? WHERE id = ?');
  const runBatch = dryRun ? (fn) => fn() : db.transaction((fn) => fn());

  runBatch(() => {
    for (const row of rows) {
      const ext = row.image_type === 'image/png' ? 'png' : 'jpg';
      const inFile = path.join(tmpDir, `${row.id}.${ext}`);
      const outFile = path.join(tmpDir, `${row.id}.webp`);
      totalBefore += row.image?.length || 0;
      if (!Buffer.isBuffer(row.image) || !row.image.length) continue;
      try {
        fs.writeFileSync(inFile, row.image);
        if (useCwebp) {
          execFileSync('cwebp', ['-q', '84', '-m', '6', '-quiet', inFile, '-o', outFile]);
        } else {
          execFileSync('ffmpeg', [
            '-y', '-loglevel', 'error', '-i', inFile,
            '-vf', "scale='min(1400,iw)':'min(1400,ih)':force_original_aspect_ratio=decrease",
            '-c:v', 'libwebp', '-quality', '84', '-compression_level', '6', outFile
          ]);
        }
        const webpBuf = fs.readFileSync(outFile);
        const isValidWebp = webpBuf.length >= 12 &&
          webpBuf.subarray(0, 4).toString('ascii') === 'RIFF' &&
          webpBuf.subarray(8, 12).toString('ascii') === 'WEBP';
        if (isValidWebp && webpBuf.length < row.image.length) {
          totalAfter += webpBuf.length;
          converted += 1;
          if (update) update.run(webpBuf, 'image/webp', row.id);
        } else {
          totalAfter += row.image.length;
        }
      } catch (err) {
        totalAfter += row.image.length;
        console.warn(`Skipped row ${row.id} (${row.style_id}): ${err.message}`);
      } finally {
        fs.rmSync(inFile, { force: true });
        fs.rmSync(outFile, { force: true });
      }
    }
  });

  console.log(`${dryRun ? '[DRY RUN] ' : ''}Scanned ${rows.length} images, ${converted} converted to WebP: ${(totalBefore / 1024).toFixed(1)} KB -> ${(totalAfter / 1024).toFixed(1)} KB`);
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  db.close();
}
