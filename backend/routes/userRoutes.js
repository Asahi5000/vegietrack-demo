const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');
const { authMiddleware, blockDemoAdminWrites, requireRole } = require('../middleware/auth');

router.use(authMiddleware, requireRole('admin'));

router.get('/', userController.getAll);
router.get('/:id', userController.getOne);
router.post('/', blockDemoAdminWrites, userController.create);
router.put('/:id', blockDemoAdminWrites, userController.update);
router.delete('/:id', blockDemoAdminWrites, userController.remove);

module.exports = router;
