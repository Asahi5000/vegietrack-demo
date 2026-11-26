const express = require('express');
const router = express.Router();
const productController = require('../controllers/productController');
const { authMiddleware, blockDemoAdminWrites } = require('../middleware/auth');

router.use(authMiddleware);

router.get('/categories', productController.getCategories);
router.post('/categories', productController.createCategory);

router.get('/', productController.getAll);
router.get('/:id', productController.getOne);
router.get('/:id/batches', productController.getBatches);
router.post('/', productController.create);
router.put('/:id', productController.update);
router.delete('/:id', blockDemoAdminWrites, productController.remove);

module.exports = router;
