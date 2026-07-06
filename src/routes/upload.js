const express = require('express');
const multer = require('multer');
const cloudinary = require('../config/cloudinary');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Only image files are allowed'));
    }
    cb(null, true);
  },
});

router.post('/photo', requireAuth, upload.single('photo'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No photo file was received' });
  }

  try {
    const base64 = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;

    const result = await cloudinary.uploader.upload(base64, {
      folder: 'yield-harvest/beneficiaries',
      resource_type: 'image',
      transformation: [{ width: 1000, height: 1000, crop: 'limit', quality: 'auto' }],
    });

    res.json({ url: result.secure_url, publicId: result.public_id });
  } catch (err) {
    console.error('Cloudinary upload error:', err);
    res.status(500).json({ error: 'Failed to upload photo' });
  }
});

router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError || err.message === 'Only image files are allowed') {
    return res.status(400).json({ error: err.message });
  }
  next(err);
});

module.exports = router;