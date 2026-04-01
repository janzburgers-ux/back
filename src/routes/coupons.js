const express = require('express');
const router = express.Router();
const Coupon = require('../models/Coupon');
const { Client, Order } = require('../models/Order');
const { auth, adminOnly } = require('../middleware/auth');

// GET todos los cupones
router.get('/', auth, adminOnly, async (req, res) => {
  try {
    const coupons = await Coupon.find()
      .populate('owner', 'name whatsapp')
      .populate('applicableProduct', 'name variant')
      .sort('-createdAt');
    res.json(coupons);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// GET estadísticas globales de cupones
router.get('/stats', auth, adminOnly, async (req, res) => {
  try {
    const coupons = await Coupon.find();
    const ordersWithCoupon = await Order.find({ coupon: { $ne: null }, status: { $ne: 'cancelled' } });

    const totalDiscountAmount = ordersWithCoupon.reduce((s, o) => s + (o.discountAmount || 0), 0);
    const totalUses = coupons.reduce((s, c) => s + c.totalUses, 0);
    const activeCoupons = coupons.filter(c => c.active).length;
    const pendingRewards = coupons.reduce((s, c) => s + (c.ownerPendingDiscount || 0), 0);

    const now = new Date();
    const monthlyDiscount = [];
    for (let i = 2; i >= 0; i--) {
      const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const end   = new Date(now.getFullYear(), now.getMonth() - i + 1, 0, 23, 59, 59);
      const monthOrders = ordersWithCoupon.filter(o => new Date(o.createdAt) >= start && new Date(o.createdAt) <= end);
      monthlyDiscount.push({
        label: start.toLocaleString('es-AR', { month: 'short', year: '2-digit' }),
        discount: monthOrders.reduce((s, o) => s + (o.discountAmount || 0), 0),
        orders: monthOrders.length,
        revenue: monthOrders.reduce((s, o) => s + o.total, 0)
      });
    }

    res.json({ totalCoupons: coupons.length, activeCoupons, totalUses, totalDiscountAmount, pendingRewards, monthlyDiscount, ordersWithCoupon: ordersWithCoupon.length });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// GET clientes cerca del umbral de fidelización
router.get('/loyalty/near-threshold', auth, adminOnly, async (req, res) => {
  try {
    const { getClientsNearThreshold } = require('../services/loyalty');
    const clients = await getClientsNearThreshold();
    res.json(clients);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// POST validar cupón (público - desde /pedido)
router.post('/validate', async (req, res) => {
  try {
    const { code, whatsapp } = req.body;
    if (!code || !whatsapp) return res.status(400).json({ message: 'Código y WhatsApp requeridos' });

    const coupon = await Coupon.findOne({ code: code.toUpperCase(), active: true })
      .populate('applicableProduct', 'name variant _id');

    if (!coupon) return res.status(404).json({ message: 'Cupón inválido o inactivo' });

    // Verificar expiración
    if (coupon.expiresAt && new Date() > new Date(coupon.expiresAt)) {
      return res.status(400).json({ message: 'Este cupón está vencido' });
    }

    if (!coupon.unlimited) {
      // Buscar cliente por whatsapp
      const client = await Client.findOne({ whatsapp, active: true });

      if (client) {
        // Verificar si ya tiene un pedido NO cancelado con este cupón
        const existingOrder = await Order.findOne({
          coupon: coupon._id,
          client: client._id,
          status: { $ne: 'cancelled' }
        });
        if (existingOrder) {
          return res.status(400).json({ message: 'Ya usaste este cupón anteriormente' });
        }
      }

      // Cupón de uso único: verificar que no haya ningún pedido activo con él
      if (coupon.singleUse) {
        const anyActiveOrder = await Order.findOne({
          coupon: coupon._id,
          status: { $ne: 'cancelled' }
        });
        if (anyActiveOrder) {
          return res.status(400).json({ message: 'Este cupón ya fue utilizado' });
        }
      }
    }

    const response = {
      valid: true,
      code: coupon.code,
      discountPercent: coupon.discountForUser,
      ownerName: coupon.ownerName,
      message: `¡Cupón válido! Tenés ${coupon.discountForUser}% de descuento 🎉`
    };

    // Si el cupón es de producto específico, informar al frontend
    if (coupon.applicableProduct) {
      response.applicableProduct = {
        _id: coupon.applicableProduct._id,
        name: coupon.applicableProduct.name,
        variant: coupon.applicableProduct.variant
      };
      response.applicableProductName = coupon.applicableProductName || `${coupon.applicableProduct.name} ${coupon.applicableProduct.variant}`;
      response.message = `¡Cupón válido! ${coupon.discountForUser}% OFF en ${response.applicableProductName} 🎉`;
    }

    res.json(response);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// POST crear cupón de referido
router.post('/', auth, adminOnly, async (req, res) => {
  try {
    const { code, ownerId, discountForUser, rewardPerUse, applicableProduct, applicableProductName, expiresAt } = req.body;
    const owner = await Client.findById(ownerId);
    if (!owner) return res.status(404).json({ message: 'Cliente no encontrado' });

    const existing = await Coupon.findOne({ code: code.toUpperCase() });
    if (existing) return res.status(400).json({ message: 'Ya existe un cupón con ese código' });

    const coupon = new Coupon({
      code: code.toUpperCase(),
      owner: owner._id,
      ownerName: owner.name,
      discountForUser: discountForUser || 10,
      rewardPerUse: rewardPerUse || 5,
      applicableProduct: applicableProduct || null,
      applicableProductName: applicableProductName || null,
      type: applicableProduct ? 'product' : 'referral',
      expiresAt: expiresAt || null
    });
    await coupon.save();
    res.status(201).json(coupon);
  } catch (err) { res.status(400).json({ message: err.message }); }
});

// POST crear cupón admin (uso ilimitado)
router.post('/admin', auth, adminOnly, async (req, res) => {
  try {
    const { code, discountForUser, label, applicableProduct, applicableProductName, expiresAt } = req.body;
    if (!code) return res.status(400).json({ message: 'Código requerido' });

    let adminClient = await Client.findOne({ name: { $regex: /admin/i } });
    if (!adminClient) {
      adminClient = await new Client({ name: 'Admin', phone: '0000000000' }).save();
    }

    const existing = await Coupon.findOne({ code: code.toUpperCase() });
    if (existing) return res.status(400).json({ message: 'Ya existe un cupón con ese código' });

    const coupon = new Coupon({
      code: code.toUpperCase(),
      owner: adminClient._id,
      ownerName: label || 'Admin',
      discountForUser: discountForUser || 0,
      rewardPerUse: 0,
      unlimited: true,
      type: applicableProduct ? 'product' : 'admin',
      applicableProduct: applicableProduct || null,
      applicableProductName: applicableProductName || null,
      expiresAt: expiresAt || null
    });
    await coupon.save();
    res.status(201).json(coupon);
  } catch (err) { res.status(400).json({ message: err.message }); }
});

// POST crear cupón de uso único
router.post('/single-use', auth, adminOnly, async (req, res) => {
  try {
    const { code, discountForUser, label, applicableProduct, applicableProductName, expiresAt } = req.body;
    if (!code) return res.status(400).json({ message: 'Código requerido' });

    let adminClient = await Client.findOne({ name: { $regex: /admin/i } });
    if (!adminClient) {
      adminClient = await new Client({ name: 'Admin', phone: '0000000000' }).save();
    }

    const existing = await Coupon.findOne({ code: code.toUpperCase() });
    if (existing) return res.status(400).json({ message: 'Ya existe un cupón con ese código' });

    const coupon = new Coupon({
      code: code.toUpperCase(),
      owner: adminClient._id,
      ownerName: label || 'Promo',
      discountForUser: discountForUser || 10,
      rewardPerUse: 0,
      unlimited: false,
      singleUse: true,
      active: true,
      type: applicableProduct ? 'product' : 'admin',
      applicableProduct: applicableProduct || null,
      applicableProductName: applicableProductName || null,
      expiresAt: expiresAt || null
    });
    await coupon.save();
    res.status(201).json(coupon);
  } catch (err) { res.status(400).json({ message: err.message }); }
});

// PATCH toggle activo
router.patch('/:id/toggle', auth, adminOnly, async (req, res) => {
  try {
    const coupon = await Coupon.findById(req.params.id);
    if (!coupon) return res.status(404).json({ message: 'Cupón no encontrado' });
    coupon.active = !coupon.active;
    await coupon.save();
    res.json(coupon);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// PUT actualizar cupón
router.put('/:id', auth, adminOnly, async (req, res) => {
  try {
    const coupon = await Coupon.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!coupon) return res.status(404).json({ message: 'Cupón no encontrado' });
    res.json(coupon);
  } catch (err) { res.status(400).json({ message: err.message }); }
});

// DELETE
router.delete('/:id', auth, adminOnly, async (req, res) => {
  try {
    await Coupon.findByIdAndDelete(req.params.id);
    res.json({ message: 'Cupón eliminado' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// POST acreditar puntos manualmente
router.post('/loyalty/award', auth, adminOnly, async (req, res) => {
  try {
    const { clientId, points } = req.body;
    const client = await Client.findByIdAndUpdate(
      clientId,
      { $inc: { loyaltyPoints: points, totalPointsEarned: points } },
      { new: true }
    );
    if (!client) return res.status(404).json({ message: 'Cliente no encontrado' });
    res.json({ message: `${points} puntos acreditados a ${client.name}`, client });
  } catch (err) { res.status(400).json({ message: err.message }); }
});

module.exports = router;
