const pool = require('../config/db');

// GET /payrolls — list all payroll records with employee info
exports.getAll = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT p.id, p.user_id, u.username, u.full_name, u.role, p.period, p.amount, p.notes, p.created_at
       FROM payrolls p
       LEFT JOIN users u ON p.user_id = u.id
       ORDER BY p.created_at DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to fetch payrolls' });
  }
};

// POST /payrolls — create a new payroll record
exports.create = async (req, res) => {
  try {
    const { employee_id, period, amount, notes } = req.body;
    if (!employee_id) return res.status(400).json({ message: 'Employee is required' });
    if (!period) return res.status(400).json({ message: 'Pay date is required' });
    if (!amount || Number(amount) <= 0) return res.status(400).json({ message: 'Amount must be greater than zero' });

    await pool.query(
      'INSERT INTO payrolls (user_id, period, amount, notes) VALUES (?, ?, ?, ?)',
      [Number(employee_id), period, Number(amount), notes || null]
    );
    res.status(201).json({ message: 'Payroll record created successfully' });
  } catch (err) {
    console.error(err);
    if (err.code === 'ER_DUP_ENTRY' || err.code === '23505') {
      return res.status(409).json({ message: 'A payroll record for this employee and period already exists' });
    }
    res.status(500).json({ message: 'Failed to create payroll record' });
  }
};

// DELETE /payrolls/:id — delete a payroll record
exports.remove = async (req, res) => {
  try {
    const [result] = await pool.query('DELETE FROM payrolls WHERE id = ?', [req.params.id]);
    if (result.affectedRows === 0) return res.status(404).json({ message: 'Payroll record not found' });
    res.json({ message: 'Payroll record deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to delete payroll record' });
  }
};
