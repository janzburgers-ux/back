const express = require('express');
const router = express.Router();
const Additional = require('../models/Additional');
const { auth, adminOnly } = require('../middleware/auth');

// GET all additionals (admin — todas las categorías)
router.get('/all', auth, adminOnly, async (req, res) => {
  try {
    const additionals = await Additional.find({ active: true }).sort('category name');
    res.json(additionals);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET additionals — público/cocina: solo adicionales (sin salsas) o filtrado por category
router.get('/', auth, async (req, res) => {
  try {
    const filter = { active: true };
    if (req.query.category) filter.category = req.query.category;
    const additionals = await Additional.find(filter).sort('name');
    res.json(additionals);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST create additional
// Acepta: name, description, price, emoji, category, appliesTo
router.post('/', auth, adminOnly, async (req, res) => {
  try {
    const additional = new Additional(req.body);
    await additional.save();
    res.status(201).json(additional);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// PUT update additional
// Acepta todos los campos incluyendo appliesTo
router.put('/:id', auth, adminOnly, async (req, res) => {
  try {
    const additional = await Additional.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    );
    if (!additional) return res.status(404).json({ message: 'Adicional no encontrado' });
    res.json(additional);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// DELETE (soft delete)
router.delete('/:id', auth, adminOnly, async (req, res) => {
  try {
    await Additional.findByIdAndUpdate(req.params.id, { active: false });
    res.json({ message: 'Adicional eliminado' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
