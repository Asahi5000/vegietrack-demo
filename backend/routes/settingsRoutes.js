const express = require('express');
const router = express.Router();
const settingsController = require('../controllers/settingsController');
const { authMiddleware, blockDemoAdminWrites, requireRole } = require('../middleware/auth');

router.use(authMiddleware);

router.get('/', settingsController.getAll);
router.put('/', requireRole('admin'), blockDemoAdminWrites, settingsController.update);

module.exports = router;
