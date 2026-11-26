const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { authMiddleware } = require('../middleware/auth');

router.post('/login', authController.login);
router.post('/demo-login', authController.demoLogin);
router.post('/forgot-password', authController.forgotPassword);
router.get('/reset-password/:token', authController.verifyResetToken);
router.post('/reset-password', authController.resetPassword);
router.get('/me', authMiddleware, authController.me);

module.exports = router;
