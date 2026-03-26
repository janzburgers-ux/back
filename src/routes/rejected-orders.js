const express = require('express');
const router = express.Router();
const RejectedOrder = require('../models/RejectedOrder');
const { Order } = require('../models/Order');
const { auth, adminOnly } = require('../middleware/auth');
const { getCurrentLoad } = require('../services/kitchen-capacity');

// GET todos los rechazados
router.get('/', auth, adminOnly, async (req, res) => {
  try {
    const { limit = 50 } = req.query;
    const rejected = await RejectedOrder.find().sort('-rejectedAt').limit(parseInt(limit));
    res.json(rejected);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// GET stats de rechazados
router.get('/stats', auth, adminOnly, async (req, res) => {
  try {
    const total = await RejectedOrder.countDocuments();
    const thisMonth = await RejectedOrder.countDocuments({
      rejectedAt: { $gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1) }
    });
    const byReason = await RejectedOrder.aggregate([
      { $group: { _id: '$reason', count: { $sum: 1 } } }
    ]);
    const totalLost = await RejectedOrder.aggregate([
      { $group: { _id: null, total: { $sum: '$total' } } }
    ]);

    // Ingredientes más frecuentemente faltantes
    const missingIngredients = await RejectedOrder.aggregate([
      { $unwind: '$missingStock' },
      { $group: { _id: '$missingStock.ingredient', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 5 }
    ]);

    res.json({ total, thisMonth, byReason, totalLost: totalLost[0]?.total || 0, missingIngredients });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// GET capacidad actual de cocina
router.get('/kitchen-load', auth, async (req, res) => {
  try {
    const load = await getCurrentLoad();
    res.json(load);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// POST registrar pedido rechazado (se llama al cancelar desde cocina)
router.post('/', auth, adminOnly, async (req, res) => {
  try {
    const { orderId, reason, notes, missingStock } = req.body;
    const order = await Order.findById(orderId).populate('client', 'name whatsapp phone');
    if (!order) return res.status(404).json({ message: 'Pedido no encontrado' });

    const rejected = new RejectedOrder({
      orderNumber: order.orderNumber,
      publicCode: order.publicCode,
      client: {
        name: order.client?.name,
        whatsapp: order.client?.whatsapp,
        phone: order.client?.phone
      },
      items: order.items.map(i => ({ productName: i.productName, variant: i.variant, quantity: i.quantity })),
      total: order.total,
      reason: reason || 'sin_stock',
      notes: notes || '',
      missingStock: missingStock || []
    });

    await rejected.save();
    res.status(201).json(rejected);
  } catch (err) { res.status(400).json({ message: err.message }); }
});

module.exports = router;
