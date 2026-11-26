const express = require('express');
const router = express.Router();
const transactionController = require('../controllers/transactionController');
const { authMiddleware, blockDemoAdminWrites, requireRole } = require('../middleware/auth');

router.use(authMiddleware);

router.get('/', transactionController.getAll);
router.post('/restock', transactionController.restock);
router.get('/:id', transactionController.getOne);
router.post('/', transactionController.create);
// Voiding/deleting a sale rewrites the sales history, so both are restricted to
// the owner (admin) and managers — cashiers can only record and view sales.
router.patch('/:id/void', requireRole('admin', 'manager'), blockDemoAdminWrites, transactionController.voidTransaction);
router.patch('/:id/unvoid', requireRole('admin', 'manager'), blockDemoAdminWrites, transactionController.unvoidTransaction);
router.delete('/:id', requireRole('admin', 'manager'), blockDemoAdminWrites, transactionController.remove);

module.exports = router;
