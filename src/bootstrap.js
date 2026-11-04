'use strict';
/* Production/startup bootstrap:
   - creates the database file if it doesn't exist yet (fresh disk on a host)
   - seeds demo data only when AUTO_SEED=1 and the database is empty
   - then starts the normal server
   Safe to run on every boot. */
const { get } = require('./db');

const AUTO_SEED = process.env.AUTO_SEED === '1';

function isEmpty() {
  try { return get('SELECT COUNT(*) n FROM users').n === 0; }
  catch (e) { return true; }
}

if (isEmpty()) {
  if (AUTO_SEED) {
    console.log('[bootstrap] empty database → seeding demo data (AUTO_SEED=1)');
    require('./seed');
  } else {
    console.log('[bootstrap] WARNING: database is empty and AUTO_SEED is not enabled.');
    console.log('[bootstrap]           Set AUTO_SEED=1 once, or run `npm run seed`.');
  }
}

// start the HTTP server from here (server.js only self-starts when run directly)
const app = require('./server');
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Mavi ERP  →  http://localhost:${PORT}/store/   (customer)`);
  console.log(`            →  http://localhost:${PORT}/admin/   (staff & owner)`);
});
