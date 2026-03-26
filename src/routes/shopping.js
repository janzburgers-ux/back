const express = require('express');
const router = express.Router();
const { auth } = require('../middleware/auth');
const { generateShoppingList, generateProductionShoppingList } = require('../services/stock.service');

// Lista de compras normal (deficit vs mínimo)
router.get('/', auth, async (req, res) => {
  try {
    const list = await generateShoppingList();
    res.json(list);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Lista de compras por objetivo de producción
router.get('/production', auth, async (req, res) => {
  try {
    const target = parseInt(req.query.target) || 50;
    const list = await generateProductionShoppingList(target);
    res.json(list);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

module.exports = router;
