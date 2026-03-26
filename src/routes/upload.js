const express = require('express');
const router = express.Router();
const { upload, cloudinary } = require('../services/cloudinary');
const { auth, adminOnly } = require('../middleware/auth');

// POST subir imagen
router.post('/', auth, adminOnly, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No se recibió ninguna imagen' });
    res.json({
      url: req.file.path,
      publicId: req.file.filename
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// DELETE eliminar imagen
router.delete('/', auth, adminOnly, async (req, res) => {
  try {
    const { publicId } = req.body;
    if (!publicId) return res.status(400).json({ message: 'publicId requerido' });
    await cloudinary.uploader.destroy(publicId);
    res.json({ message: 'Imagen eliminada' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
