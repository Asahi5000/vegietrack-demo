const bcrypt = require('bcryptjs');
const pool = require('../config/db');

async function getAdminEmailSettings() {
  const [admins] = await pool.query(
    `SELECT email, gmail_app_password
     FROM users
     WHERE role = 'admin'
     ORDER BY id ASC
     LIMIT 1`
  );
  return admins[0] || { email: null, gmail_app_password: null };
}

function sanitizeUser(user) {
  const safeUser = { ...user };
  delete safeUser.password;
  delete safeUser.gmail_app_password;
  return safeUser;
}

exports.getAll = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT id, username, full_name, email, role, status, payroll, created_at FROM users ORDER BY created_at DESC');
    const safeRows = rows.map(sanitizeUser);
    const admin = safeRows
      .filter((user) => user.role === 'admin')
      .sort((a, b) => Number(a.id) - Number(b.id))[0];
    res.json(admin ? safeRows.map((user) => ({ ...user, email: admin.email })) : safeRows);
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch users' });
  }
};

exports.getOne = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT id, username, full_name, email, role, status, payroll, created_at FROM users WHERE id = ?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ message: 'User not found' });
    res.json(sanitizeUser(rows[0]));
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch user' });
  }
};

exports.create = async (req, res) => {
  try {
    const { username, password, full_name, role, status, payroll } = req.body;
    if (!username || !password) {
      return res.status(400).json({ message: 'Username and password are required' });
    }
    const adminEmailSettings = await getAdminEmailSettings();
    // Daily payroll lives on users.payroll — it must be saved at create time,
    // otherwise every new user shows ₱0.00. Non-payroll roles (admin) store 0.
    const payrollValue = (role === 'manager' || role === 'cashier') && payroll !== undefined && payroll !== null && payroll !== ''
      ? Number(payroll)
      : 0;
    if (Number.isNaN(payrollValue) || payrollValue < 0) {
      return res.status(400).json({ message: 'Daily payroll must be zero or greater' });
    }
    const hashed = await bcrypt.hash(password, 10);
    const [result] = await pool.query(
      `INSERT INTO users (username, password, full_name, email, gmail_app_password, role, status, payroll) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [username, hashed, full_name || null, adminEmailSettings.email, adminEmailSettings.gmail_app_password, role || 'cashier', status || 'active', payrollValue]
    );
    res.status(201).json({ id: result.insertId, message: 'User created successfully' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY' || err.code === '23505')
      return res.status(409).json({ message: 'Username already exists' });
    console.error(err);
    res.status(500).json({ message: 'Failed to create user' });
  }
};

exports.update = async (req, res) => {
  try {
    const { full_name, email, gmail_app_password, role, status, password, payroll } = req.body;
    const [existingUsers] = await pool.query('SELECT id, role, email, gmail_app_password FROM users WHERE id = ?', [req.params.id]);
    if (existingUsers.length === 0) return res.status(404).json({ message: 'User not found' });
    const existingUser = existingUsers[0];
    const isAdminAccount = existingUser.role === 'admin';
    const sets = [];
    const vals = [];
    if (full_name !== undefined) { sets.push('full_name = ?'); vals.push(full_name || null); }
    if (isAdminAccount && email !== undefined) { sets.push('email = ?'); vals.push(email || null); }
    if (isAdminAccount && gmail_app_password !== undefined) { sets.push('gmail_app_password = ?'); vals.push(gmail_app_password || null); }
    if (role !== undefined) { sets.push('role = ?'); vals.push(role || 'cashier'); }
    if (status !== undefined) { sets.push('status = ?'); vals.push(status || 'active'); }
    if (password) {
      const hashed = await bcrypt.hash(password, 10);
      sets.push('password = ?'); vals.push(hashed);
    }
    if (payroll !== undefined) {
      // Blank input means "keep it simple": store 0 rather than ''/NULL so
      // the Daily Payroll column always renders a number, never ₱0.00-by-accident.
      const payrollValue = payroll === '' || payroll === null ? 0 : Number(payroll);
      if (Number.isNaN(payrollValue) || payrollValue < 0) {
        return res.status(400).json({ message: 'Daily payroll must be zero or greater' });
      }
      sets.push('payroll = ?'); vals.push(payrollValue);
    }
    if (sets.length === 0) return res.status(400).json({ message: 'Nothing to update' });
    sets.push('updated_at = CURRENT_TIMESTAMP');
    vals.push(req.params.id);
    await pool.query(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, vals);
    if (isAdminAccount && (email !== undefined || gmail_app_password !== undefined)) {
      const adminEmail = email !== undefined ? (email || null) : existingUser.email;
      const adminAppPassword = gmail_app_password !== undefined
        ? (gmail_app_password || null)
        : existingUser.gmail_app_password;
      await pool.query(
        `UPDATE users
         SET email = ?, gmail_app_password = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id <> ?`,
        [adminEmail, adminAppPassword, req.params.id]
      );
    }
    res.json({ message: 'User updated successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to update user' });
  }
};

exports.remove = async (req, res) => {
  try {
    if (Number(req.params.id) === req.user.id) {
      return res.status(400).json({ message: 'You cannot delete your own account' });
    }
    const [result] = await pool.query('DELETE FROM users WHERE id = ?', [req.params.id]);
    if (result.affectedRows === 0) return res.status(404).json({ message: 'User not found' });
    res.json({ message: 'User deleted successfully' });
  } catch (err) {
    res.status(500).json({ message: 'Failed to delete user' });
  }
};
