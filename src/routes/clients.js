const express = require('express');
const router = express.Router();
const { Client, Order } = require('../models/Order');
const { auth, adminOnly } = require('../middleware/auth');

// Get all clients
router.get('/', auth, async (req, res) => {
  try {
    const { search } = req.query;
    const filter = { active: true };
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { phone: { $regex: search, $options: 'i' } }
      ];
    }
    const clients = await Client.find(filter).sort('-totalSpent');
    res.json(clients);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Get client with order history
router.get('/:id', auth, async (req, res) => {
  try {
    const client = await Client.findById(req.params.id);
    if (!client) return res.status(404).json({ message: 'Cliente no encontrado' });
    
    const orders = await Order.find({ client: req.params.id })
      .populate('items.product', 'name variant')
      .sort({ createdAt: -1 })
      .limit(20);
    
    res.json({ client, orders });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Create client
router.post('/', auth, async (req, res) => {
  try {
    const client = new Client(req.body);
    await client.save();
    res.status(201).json(client);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// Update client
router.put('/:id', auth, async (req, res) => {
  try {
    const client = await Client.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!client) return res.status(404).json({ message: 'Cliente no encontrado' });
    res.json(client);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// Delete client (soft)
router.delete('/:id', auth, adminOnly, async (req, res) => {
  try {
    await Client.findByIdAndUpdate(req.params.id, { active: false });
    res.json({ message: 'Cliente eliminado' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
