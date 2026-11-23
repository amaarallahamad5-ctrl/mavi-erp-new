#!/usr/bin/env node
'use strict';
/* Offline, read-only MAVI SQLite backup verifier.
   Usage:
     node scripts/verify-backup-file.js <path-to-backup.db> [--expect-sha256 <hex>] [--json]
   - Never opens the file in write mode (`readonly: true`, `query_only = ON`).
   - Computes SHA-256 using a single reusable 64 KiB buffer (low memory even on large backups).
   - Verifies SQLite header magic, `PRAGMA integrity_check`, required MAVI tables,
     and `PRAGMA foreign_key_check`, then prints non-sensitive row counts. */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'utf8');
const REQUIRED_TABLES = ['users', 'customers', 'orders', 'order_items', 'payments', 'styles'];

function parseArgs(argv) {
  let filePath = null;
  let expectSha256 = null;
  let jsonOut = false;
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') {
      jsonOut = true;
    } else if (arg === '--expect-sha256') {
      expectSha256 = String(argv[++i] || '').trim().toLowerCase();
    } else if (arg.startsWith('--expect-sha256=')) {
      expectSha256 = arg.slice('--expect-sha256='.length).trim().toLowerCase();
    } else if (!arg.startsWith('-') && !filePath) {
      filePath = arg;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!filePath) {
    throw new Error('Usage: node scripts/verify-backup-file.js <backup.db> [--expect-sha256 <hex>] [--json]');
  }
  if (expectSha256 && !/^[0-9a-f]{64}$/.test(expectSha256)) {
    throw new Error('--expect-sha256 must be a 64-character hex SHA-256 digest');
  }
  return { filePath: path.resolve(filePath), expectSha256, jsonOut };
}

function hashAndCheckHeader(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const hash = crypto.createHash('sha256');
    const buf = Buffer.allocUnsafe(65536);
    let totalBytes = 0;
    let checkedMagic = false;
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      if (!checkedMagic) {
        if (n < 16 || !buf.subarray(0, 16).equals(SQLITE_MAGIC)) {
          throw new Error('not_sqlite_format_3');
        }
        checkedMagic = true;
      }
      totalBytes += n;
      hash.update(n === buf.length ? buf : buf.subarray(0, n));
    }
    if (!checkedMagic || totalBytes < 4096) {
      throw new Error('file_too_small_for_sqlite');
    }
    return { bytes: totalBytes, sha256: hash.digest('hex') };
  } finally {
    fs.closeSync(fd);
  }
}

function verifyBackup(filePath, expectSha256 = null) {
  if (!fs.existsSync(filePath)) {
    throw new Error('file_not_found');
  }
  const st = fs.statSync(filePath);
  if (!st.isFile()) {
    throw new Error('not_regular_file');
  }

  const { bytes, sha256 } = hashAndCheckHeader(filePath);
  if (expectSha256 && sha256 !== expectSha256) {
    throw new Error(`sha256_mismatch: expected ${expectSha256}, actual ${sha256}`);
  }

  const hadWalBefore = fs.existsSync(filePath + '-wal');
  const hadShmBefore = fs.existsSync(filePath + '-shm');
  const db = new Database(filePath, { readonly: true, fileMustExist: true });
  try {
    db.pragma('mmap_size = 0');
    db.pragma('cache_size = -4096');
    db.pragma('temp_store = FILE');
    db.pragma('query_only = ON');

    const integrity = db.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') {
      throw new Error(`integrity_check_failed: ${integrity}`);
    }

    const existingTables = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name)
    );
    for (const reqTable of REQUIRED_TABLES) {
      if (!existingTables.has(reqTable)) {
        throw new Error(`missing_required_table: ${reqTable}`);
      }
    }

    const fkErrors = db.pragma('foreign_key_check');
    if (fkErrors.length > 0) {
      throw new Error(`foreign_key_check_failed: ${fkErrors.length} violations`);
    }

    const countTables = [
      'users',
      'customers',
      'styles',
      'style_images',
      'orders',
      'order_items',
      'payments',
      'order_refunds',
      'custom_requests',
      'office_cases',
      'office_jobs',
    ];
    const counts = {};
    for (const t of countTables) {
      counts[t] = existingTables.has(t) ? db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n : null;
    }

    return {
      ok: true,
      file: path.basename(filePath),
      bytes,
      mib: Number((bytes / (1024 * 1024)).toFixed(2)),
      sha256,
      sha256_matched_expected: expectSha256 ? true : null,
      integrity_check: 'ok',
      foreign_key_violations: 0,
      has_office_schema: existingTables.has('office_cases') && existingTables.has('office_jobs'),
      counts,
    };
  } finally {
    db.close();
    // SQLite's read-only open of a WAL-flagged snapshot can leave empty 0-byte -wal/-shm sidecars; remove only newly created empty ones.
    if (!hadWalBefore && fs.existsSync(filePath + '-wal')) {
      try { if (fs.statSync(filePath + '-wal').size === 0) fs.unlinkSync(filePath + '-wal'); } catch (_) {}
    }
    if (!hadShmBefore && fs.existsSync(filePath + '-shm')) {
      try { fs.unlinkSync(filePath + '-shm'); } catch (_) {}
    }
  }
}

if (require.main === module) {
  try {
    const { filePath, expectSha256, jsonOut } = parseArgs(process.argv);
    const report = verifyBackup(filePath, expectSha256);
    if (jsonOut) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log('✓ فحص النسخة الاحتياطية ناجح (وضع قراءة فقط دون تعديل الملف)');
      console.log(`  الملف:   ${report.file}`);
      console.log(`  الحجم:   ${report.bytes} بايت (${report.mib} MiB)`);
      console.log(`  SHA-256: ${report.sha256}`);
      if (report.sha256_matched_expected) {
        console.log('  مطابقة البصمة المتوقعة: مطابقة ✓');
      }
      console.log(`  سلامة القاعدة (integrity_check): ${report.integrity_check}`);
      console.log(`  أخطاء المفاتيح الأجنبية: ${report.foreign_key_violations}`);
      console.log(`  ملخص السجلات: الطلبات=${report.counts.orders}، العميلات=${report.counts.customers}، الموديلات=${report.counts.styles}، الصور=${report.counts.style_images ?? 0}`);
    }
  } catch (err) {
    console.error(`✗ فشل التحقق من النسخة الاحتياطية: ${err.message || err}`);
    process.exit(1);
  }
}

module.exports = { verifyBackup };
