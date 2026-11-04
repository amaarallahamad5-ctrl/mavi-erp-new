'use strict';
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'mavi.db');

function open() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  return db;
}

const db = open();

/* ---------- tiny helpers ---------- */
const get  = (sql, ...a) => db.prepare(sql).get(...a);
const all  = (sql, ...a) => db.prepare(sql).all(...a);
const run  = (sql, ...a) => db.prepare(sql).run(...a);

function setting(key, fallback = null) {
  const row = get('SELECT value FROM settings WHERE key = ?', key);
  return row ? row.value : fallback;
}
function setSetting(key, value) {
  run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      key, String(value));
}

function audit(entity, entityId, action, actor, detail) {
  run('INSERT INTO events(entity,entity_id,action,actor,detail) VALUES(?,?,?,?,?)',
      entity, String(entityId), action, actor || null,
      detail ? JSON.stringify(detail) : null);
}

module.exports = { db, get, all, run, setting, setSetting, audit, DB_PATH };
