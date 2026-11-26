const pool = require('../config/db');

exports.getAll = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT setting_key, setting_value FROM settings');
    const settings = {};
    rows.forEach(r => { settings[r.setting_key] = r.setting_value; });
    settings.currency = 'PHP';
    res.json(settings);
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch settings' });
  }
};

exports.update = async (req, res) => {
  try {
    const entries = Object.entries(req.body || {}).filter(([key]) => key !== 'currency');
    // Dialect-neutral upsert (works on MySQL and PostgreSQL alike): try an
    // UPDATE first, fall back to an INSERT when the key does not exist yet.
    for (const [key, value] of entries) {
      const [upd] = await pool.query(
        'UPDATE settings SET setting_value = ? WHERE setting_key = ?',
        [String(value), key]
      );
      if (!upd.affectedRows) {
        await pool.query(
          'INSERT INTO settings (setting_key, setting_value) VALUES (?, ?)',
          [key, String(value)]
        );
      }
    }
    res.json({ message: 'Settings updated successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to update settings' });
  }
};
