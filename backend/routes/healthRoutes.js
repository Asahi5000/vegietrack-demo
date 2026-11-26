// Health and diagnostic endpoints, shared by the local Node server (server.js)
// and the Vercel serverless function (server-vercel.js).
const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { authMiddleware, blockDemoAdminWrites } = require('../middleware/auth');

// GET /api/health - deployment smoke test (does not touch the database).
router.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'VegieTrack API is running' });
});

// Names only (never values) of the environment variables that could hold
// database/auth configuration. Included in the failure response so a missing or
// misnamed variable in the hosting dashboard can be identified without access to
// the runtime logs.
function relevantEnvKeys() {
  return Object.keys(process.env)
    .filter((key) => /(^|_)(DB|PG|POSTGRES|SUPABASE|DATABASE|JWT)/i.test(key))
    .sort();
}

// GET /api/health/db - reports the resolved database connection (never the
// password) and whether a query succeeds, so database/deployment problems can be
// diagnosed straight from a browser without access to the hosting runtime logs.
router.get('/db', async (req, res) => {
  const info = typeof pool.describeConnection === 'function' ? pool.describeConnection() : {};
  try {
    // Serverless-friendly: run the FIFO batch schema migration on first check.
    if (typeof pool.ensureInventoryBatchSchema === 'function') {
      await pool.ensureInventoryBatchSchema();
    }
    await pool.query('SELECT 1');
    // Also report the products.image_url column type: base64 data URLs are
    // thousands of characters, so a legacy VARCHAR(255) column rejects EVERY
    // photo with 22001/ER_DATA_TOO_LONG (surfaces as PUT /products/:id 413).
    let imageUrlColumn = null;
    try {
      const [cols] = await pool.query(
        `SELECT column_name, data_type, character_maximum_length
         FROM information_schema.columns
         WHERE table_name = 'products' AND column_name = 'image_url'`
      );
      imageUrlColumn = cols && cols[0] ? cols[0] : null;
    } catch (colErr) {
      imageUrlColumn = { error: String(colErr.message || colErr).slice(0, 120) };
    }
    res.json({ status: 'ok', ...info, connected: true, image_url_column: imageUrlColumn });
  } catch (err) {
    console.error('Database health check failed:', err);
    res.status(500).json({
      status: 'error',
      ...info,
      connected: false,
      code: err.code || null,
      message: String(err.message || err).slice(0, 300),
      envKeys: relevantEnvKeys()
    });
  }
});

// POST /api/health/migrate-image-url - one-click self-healing migration for the
// product-photo 500/413 bug. Widens products.image_url to TEXT (PostgreSQL) or
// MEDIUMTEXT (MySQL) so base64 data URLs fit. Any logged-in staff role can run
// it (it only widens one column, and ALTER is idempotent), safe to leave mounted
// in production: run it once from the browser, then every photo upload works.
router.post('/migrate-image-url', authMiddleware, blockDemoAdminWrites, async (req, res) => {
  try {
    const info = typeof pool.describeConnection === 'function' ? pool.describeConnection() : {};
    const isPg = info && info.driver === 'postgres';
    if (isPg) {
      await pool.query('ALTER TABLE products ALTER COLUMN image_url TYPE TEXT');
    } else {
      await pool.query('ALTER TABLE products MODIFY image_url MEDIUMTEXT NULL');
    }
    const [cols] = await pool.query(
      `SELECT column_name, data_type, character_maximum_length
       FROM information_schema.columns
       WHERE table_name = 'products' AND column_name = 'image_url'`
    );
    res.json({ status: 'ok', message: 'products.image_url widened successfully — photo uploads should now work', column: cols && cols[0] ? cols[0] : null });
  } catch (err) {
    console.error('image_url migration failed:', err);
    res.status(500).json({
      status: 'error',
      code: err.code || null,
      message: String(err.message || err).slice(0, 300),
      hint: 'Run manually: PostgreSQL: ALTER TABLE products ALTER COLUMN image_url TYPE TEXT; MySQL: ALTER TABLE products MODIFY image_url MEDIUMTEXT NULL;'
    });
  }
});

module.exports = router;
