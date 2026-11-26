const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
require('dotenv').config();

// Standard 500 payload for this controller. A database configuration problem
// (ECONFIG) tells the client exactly how to fix the deployment, so that message
// is returned verbatim; every other failure stays generic and is only logged.
function serverError(res, err, fallbackMessage) {
  const code = (err && err.code) || 'SERVER_ERROR';
  const message = code === 'ECONFIG' ? err.message : fallbackMessage;
  return res.status(500).json({ message, code });
}

exports.login = async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ message: 'Username and password are required' });
    }

    const [rows] = await pool.query('SELECT * FROM users WHERE username = ?', [username]);
    if (rows.length === 0) {
      return res.status(401).json({ message: 'Invalid username or password' });
    }

    const user = rows[0];

    if (user.status !== 'active') {
      return res.status(403).json({ message: 'Account is inactive. Contact administrator.' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ message: 'Invalid username or password' });
    }

    // Signing an undefined secret throws an opaque error, so report the missing
    // configuration explicitly (the same code the db layer uses).
    if (!process.env.DEMO_JWT_SECRET) {
      const err = new Error(
        'DEMO_JWT_SECRET is not configured for this deployment. Add DEMO_JWT_SECRET to the ' +
          'project Environment Variables in Vercel, then redeploy.'
      );
      err.code = 'ECONFIG';
      throw err;
    }

    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role, full_name: user.full_name, demo_mode: true },
      process.env.DEMO_JWT_SECRET,
      { expiresIn: process.env.DEMO_JWT_EXPIRES_IN || '2h' }
    );

    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        full_name: user.full_name,
        email: user.email,
        role: user.role,
        demo_mode: true
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    return serverError(res, err, 'Server error during login');
  }
};

exports.demoLogin = async (_req, res) => {
  try {
    if (!process.env.DEMO_JWT_SECRET) {
      return res.status(500).json({
        message: 'Demo login is unavailable until the server is configured.',
        code: 'ECONFIG'
      });
    }

    const username = process.env.DEMO_LOGIN_USERNAME || 'demo';
    const [rows] = await pool.query(
      'SELECT id, username, full_name, email, role, status FROM users WHERE username = ?',
      [username]
    );
    if (rows.length === 0 || rows[0].status !== 'active' || rows[0].role !== 'admin') {
      return res.status(503).json({
        message: 'The demo account is not available. Initialize the separate demo database.',
        code: 'DEMO_ACCOUNT_UNAVAILABLE'
      });
    }

    const user = rows[0];
    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role, full_name: user.full_name, demo_mode: true },
      process.env.DEMO_JWT_SECRET,
      { expiresIn: process.env.DEMO_JWT_EXPIRES_IN || '2h' }
    );

    return res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        full_name: user.full_name,
        email: user.email,
        role: user.role,
        demo_mode: true
      }
    });
  } catch (err) {
    console.error('Demo login error:', err);
    return serverError(res, err, 'Demo login is temporarily unavailable');
  }
};

exports.forgotPassword = async (_req, res) => (
  res.status(403).json({ message: 'Password recovery is disabled in the public demo.' })
);

exports.verifyResetToken = async (_req, res) => (
  res.status(403).json({ valid: false, message: 'Password recovery is disabled in the public demo.' })
);

exports.resetPassword = async (_req, res) => (
  res.status(403).json({ message: 'Password changes are disabled in the public demo.' })
);

exports.me = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT id, username, full_name, email, role, status FROM users WHERE id = ?', [req.user.id]);
    if (rows.length === 0) return res.status(404).json({ message: 'User not found' });
    res.json(rows[0]);
  } catch (err) {
    return serverError(res, err, 'Server error');
  }
};
