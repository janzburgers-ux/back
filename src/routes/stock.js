const express = require('express');
const router = express.Router();
const Stock = require('../models/Stock');
const Ingredient = require('../models/Ingredient');
const { auth, adminOnly } = require('../middleware/auth');
const { autoUpdateProductAvailability } = require('../services/stock.service');

// Get all stock
router.get('/', auth, async (req, res) => {
  try {
    const stocks = await Stock.find().populate('ingredient').sort('status');
    res.json(stocks);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Update stock level
router.put('/:id', auth, adminOnly, async (req, res) => {
  try {
    const { currentStock, minimumStock, notes } = req.body;
    const stock = await Stock.findById(req.params.id);
    if (!stock) return res.status(404).json({ message: 'Stock no encontrado' });

    if (currentStock !== undefined) stock.currentStock = currentStock;
    if (minimumStock !== undefined) stock.minimumStock = minimumStock;
    if (notes !== undefined) stock.notes = notes;
    
    await stock.save();
    autoUpdateProductAvailability().catch(e => console.error('Auto-availability error:', e.message));

    const populated = await Stock.findById(stock._id).populate('ingredient');
    res.json(populated);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// Bulk update stock (for receiving orders)
router.post('/bulk-update', auth, adminOnly, async (req, res) => {
  try {
    const { updates } = req.body; // [{ stockId, addQuantity }]
    const results = [];
    
    for (const update of updates) {
      const stock = await Stock.findById(update.stockId);
      if (!stock) continue;
      
      stock.currentStock += update.addQuantity;
      await stock.save();
      results.push(await Stock.findById(stock._id).populate('ingredient'));
    }

    autoUpdateProductAvailability().catch(e => console.error('Auto-availability error:', e.message));
    res.json(results);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// Create stock entry for new ingredient
router.post('/', auth, adminOnly, async (req, res) => {
  try {
    const stock = new Stock(req.body);
    await stock.save();
    const populated = await Stock.findById(stock._id).populate('ingredient');
    res.status(201).json(populated);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

module.exports = router;

// GET alertas activas (bajo mínimo y no vistas)
router.get('/alerts', auth, async (req, res) => {
  try {
    const alerts = await Stock.find({
      status: { $in: ['low', 'out'] }
    }).populate('ingredient').sort({ status: 1, 'ingredient.priority': 1 });
    res.json(alerts);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// PUT marcar alerta como vista
router.put('/:id/dismiss', auth, adminOnly, async (req, res) => {
  try {
    const stock = await Stock.findByIdAndUpdate(
      req.params.id,
      { alertSeen: true },
      { new: true }
    ).populate('ingredient');
    if (!stock) return res.status(404).json({ message: 'No encontrado' });
    res.json(stock);
  } catch (err) { res.status(400).json({ message: err.message }); }
});

// PUT marcar todas las alertas como vistas
router.put('/alerts/dismiss-all', auth, adminOnly, async (req, res) => {
  try {
    await Stock.updateMany({ status: { $in: ['low', 'out'] } }, { alertSeen: true });
    res.json({ message: 'Todas las alertas marcadas como vistas' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});
