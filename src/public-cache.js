'use strict';
const crypto = require('node:crypto');

const store = new Map();
let catalogueVer = 0;

function makeEtag(payload) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
  return '"' + crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16) + '"';
}

function getOrCompute(key, ttlMs, computeFn) {
  const now = Date.now();
  const cached = store.get(key);
  if (cached && cached.expiresAt > now) {
    return cached;
  }
  const value = computeFn();
  const entry = {
    value,
    etag: makeEtag(typeof value === 'string' ? value : JSON.stringify(value)),
    expiresAt: now + ttlMs,
  };
  store.set(key, entry);
  return entry;
}

function invalidate(key) {
  if (key) store.delete(key);
}

function invalidatePrefix(prefix) {
  for (const k of store.keys()) {
    if (k.startsWith(prefix)) store.delete(k);
  }
}

function invalidateCatalogue() {
  catalogueVer++;
  store.delete('catalogue_json');
  store.delete('sitemap_xml');
  store.delete('store_home_html');
  invalidatePrefix('product_page:');
}

function getCatalogueVersion() {
  return catalogueVer;
}

function invalidateReviews() {
  store.delete('reviews_json');
}

function invalidateAll() {
  catalogueVer++;
  store.clear();
}

module.exports = {
  getOrCompute,
  invalidate,
  invalidatePrefix,
  invalidateCatalogue,
  invalidateReviews,
  invalidateAll,
  getCatalogueVersion,
};
