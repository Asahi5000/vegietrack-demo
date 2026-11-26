// Product images are stored as base64 data URLs directly in the product row's
// image_url column instead of on disk. The serverless filesystem on Vercel is
// read-only and ephemeral (files vanish between invocations), so a data URL is
// the only storage option that works unchanged on both XAMPP and Vercel.
//
// NOTE: products.image_url MUST be TEXT (PostgreSQL) / MEDIUMTEXT (MySQL).
// A VARCHAR(255) column rejects any real data URL with 22001 (Postgres) or
// 1406 (MySQL), which surfaces as `PUT /api/products/:id 500`. If an older
// deployment still has VARCHAR(255), run:
//   PostgreSQL: ALTER TABLE products ALTER COLUMN image_url TYPE TEXT;
//   MySQL:      ALTER TABLE products MODIFY image_url MEDIUMTEXT NULL;
const multer = require('multer');

const MAX_BYTES = 2 * 1024 * 1024; // 2 MB — keeps the base64 JSON well under Vercel's ~4.5 MB body cap
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES },
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (!allowed.includes(file.mimetype)) {
      const err = new Error('Only JPEG, PNG, and WebP images are allowed');
      err.status = 400;
      return cb(err);
    }
    cb(null, true);
  },
});

// Wrap multer.single so MulterError / fileFilter errors become clean 400/413
// JSON responses instead of falling through to the 500 global handler.
function handleUpload(req, res, next) {
  upload.single('image')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ message: 'Image must be smaller than 2 MB after compression. Try a smaller photo.' });
      }
      const status = err.status || 400;
      return res.status(status).json({ message: err.message || 'Invalid image upload' });
    }
    next();
  });
}

exports.uploadProductImage = [
  handleUpload,
  (req, res) => {
    if (!req.file) {
      return res.status(400).json({ message: 'No image file was provided' });
    }
    // Guard against absurd payloads even after multer (e.g. tiny PNG that
    // explodes when re-encoded). 2 MB -> ~2.8 MB base64, safe for DB TEXT.
    const image_url = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
    if (image_url.length > 4 * 1024 * 1024) {
      return res.status(413).json({ message: 'Compressed image is still too large. Please use a smaller photo.' });
    }
    res.json({ image_url });
  }
];

// The frontend calls DELETE after a failed product save to avoid orphan files.
// With data-URL storage there is no server-side file to remove (the URL only
// becomes stored data once a product row is saved), so acknowledge the request.
exports.removeProductImage = (_req, res) => {
  res.json({ message: 'Nothing to delete' });
};
