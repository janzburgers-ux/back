const express = require('express');
const router = express.Router();
const Config = require('../models/Config');
const { auth, adminOnly } = require('../middleware/auth');

// GET /api/whatsapp-templates — devuelve todos los templates guardados
router.get('/', auth, adminOnly, async (req, res) => {
  try {
    const cfg = await Config.findOne({ key: 'whatsappTemplates' });
    res.json(cfg?.value || {});
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PUT /api/whatsapp-templates — guarda un template específico
router.put('/', auth, adminOnly, async (req, res) => {
  try {
    const { key, template } = req.body;
    if (!key || !template) return res.status(400).json({ message: 'key y template son requeridos' });

    const cfg = await Config.findOne({ key: 'whatsappTemplates' });
    const current = cfg?.value || {};
    const updated = { ...current, [key]: template };

    await Config.findOneAndUpdate(
      { key: 'whatsappTemplates' },
      { $set: { key: 'whatsappTemplates', value: updated } },
      { upsert: true, new: true }
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
