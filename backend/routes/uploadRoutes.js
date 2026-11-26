const express = require('express');
const router = express.Router();
const uploadController = require('../controllers/uploadController');
const { authMiddleware } = require('../middleware/auth');

router.use(authMiddleware);

// Field name must stay "image" — the frontend appends the file under that key.
router.post('/product-image', uploadController.uploadProductImage);
router.delete('/product-image', uploadController.removeProductImage);

module.exports = router;
