const express = require('express');
const cors = require('cors');
require('dotenv').config();

const authRoutes = require('./routes/authRoutes');
const productRoutes = require('./routes/productRoutes');
const transactionRoutes = require('./routes/transactionRoutes');
const reportRoutes = require('./routes/reportRoutes');
const spoiledRoutes = require('./routes/spoiledRoutes');
const userRoutes = require('./routes/userRoutes');
const settingsRoutes = require('./routes/settingsRoutes');
const payrollRoutes = require('./routes/payrollRoutes');
const uploadRoutes = require('./routes/uploadRoutes');
const healthRoutes = require('./routes/healthRoutes');

const pool = require('./config/db');

// Self-migrate the FIFO batch-level inventory schema on startup.
// Creates inventory_batches table and adds shelf_life_days column if the DB
// is behind. Errors are non-fatal — the app still works without FIFO tracking.
(async () => {
  try {
    await pool.ensureInventoryBatchSchema();
  } catch (err) {
    console.error('ensureInventoryBatchSchema error:', err.message);
  }
})();

const app = express();

app.use(cors({
  origin: ['http://localhost:5173', 'http://localhost:3000']
}));
app.use(express.json({ limit: '10mb' })); // product image data URLs can exceed the 100kb default

// Health/diagnostic probes (GET /api/health and GET /api/health/db).
app.use('/api/health', healthRoutes);

app.use('/api/auth', authRoutes);
app.use('/api/products', productRoutes);
app.use('/api/transactions', transactionRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/spoiled-products', spoiledRoutes);
app.use('/api/users', userRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/payrolls', payrollRoutes);
app.use('/api/upload', uploadRoutes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ message: 'Endpoint not found' });
});

// Express has no status on JSON body-too-large errors by default; surface them
// as 413 (not 500) so the frontend can tell the user to use a smaller photo.
// Global error handler
app.use((err, req, res, next) => {
  if (err && (err.type === 'entity.too.large' || err.status === 413)) {
    return res.status(413).json({ message: 'Image is too large. Please use a photo smaller than 2 MB.' });
  }
  if (err && err.status && err.status < 500) {
    return res.status(err.status).json({ message: err.message || 'Request failed' });
  }
  console.error(err.stack);
  res.status(500).json({ message: 'Internal server error' });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`IMS backend server running on http://localhost:${PORT}`);
});
