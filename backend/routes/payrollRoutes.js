const express = require('express');
const router = express.Router();
const payrollController = require('../controllers/payrollController');
const { authMiddleware, blockDemoAdminWrites, requireRole } = require('../middleware/auth');

router.use(authMiddleware, requireRole('admin'));

router.get('/', payrollController.getAll);
router.post('/', blockDemoAdminWrites, payrollController.create);
router.delete('/:id', blockDemoAdminWrites, payrollController.remove);

module.exports = router;
