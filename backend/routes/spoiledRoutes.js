const express = require('express');
const router = express.Router();
const reportController = require('../controllers/reportController');
const { authMiddleware, blockDemoAdminWrites, requireRole } = require('../middleware/auth');

router.use(authMiddleware);

// POST /api/spoiled-products — record a stock write-off for spoiled produce.
// Mounted at the API root (not under /api/reports) because it is an
// inventory write operation, not a report.
router.post('/', blockDemoAdminWrites, reportController.recordSpoiledProduct);
router.delete('/:id', requireRole('admin', 'manager'), blockDemoAdminWrites, reportController.deleteSpoiledProduct);
router.put('/:id', requireRole('admin', 'manager'), blockDemoAdminWrites, reportController.updateSpoiledProduct);

module.exports = router;