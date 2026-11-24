'use strict';
// Sequential isolated backend & UI-asset test runner.
// Never points at a production database; each suite creates its own disposable SQLite file.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const testDir = path.join(root, 'test');
const filter = process.argv[2] || '';

const files = fs.readdirSync(testDir)
  .filter(f => f.endsWith('.test.js') && (!filter || f.includes(filter)))
  .sort();

if (!files.length) {
  console.error('No matching test files found.');
  process.exit(1);
}

let passed = 0;
let failed = 0;
const startedAt = Date.now();

for (const file of files) {
  const fullPath = path.join(testDir, file);
  const t0 = Date.now();
  process.stdout.write(`▶ ${file} ... `);
  const res = spawnSync(process.execPath, [fullPath], {
    cwd: root,
    env: { ...process.env, AUTO_SEED: '0' },
    encoding: 'utf8',
    timeout: 120000,
  });
  const ms = Date.now() - t0;
  if (res.status === 0) {
    passed++;
    console.log(`PASS (${ms}ms)`);
  } else {
    failed++;
    console.log(`FAIL (exit=${res.status}, ${ms}ms)`);
    if (res.stdout) process.stdout.write(res.stdout);
    if (res.stderr) process.stderr.write(res.stderr);
  }
}

const totalSec = ((Date.now() - startedAt) / 1000).toFixed(1);
console.log(`\nSummary: ${passed}/${files.length} suites passed, ${failed} failed in ${totalSec}s.`);
if (failed > 0) process.exit(1);
