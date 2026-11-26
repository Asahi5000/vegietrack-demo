const express = require('express');
const router = express.Router();
const reportController = require('../controllers/reportController');
const { authMiddleware, blockDemoAdminWrites, requireRole } = require('../middleware/auth');

router.use(authMiddleware);

router.get('/dashboard', reportController.dashboard);
router.get('/sales', reportController.salesReport);
router.get('/inventory', reportController.inventoryReport);
router.get('/expenses', requireRole('admin', 'manager'), reportController.getExpenses);
router.post('/expenses', requireRole('admin', 'manager'), blockDemoAdminWrites, reportController.createExpense);
router.put('/expenses/:id', requireRole('admin', 'manager'), blockDemoAdminWrites, reportController.updateExpense);
router.delete('/expenses/:id', requireRole('admin', 'manager'), blockDemoAdminWrites, reportController.deleteExpense);

module.exports = router;
