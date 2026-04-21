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

// GET panel de referidos — cupones con % acumulado para canjear
router.get('/referral/panel', auth, adminOnly, async (req, res) => {
  try {
    const referrals = await Coupon.find({ type: 'referral' })
      .populate('owner', 'name whatsapp')
      .sort({ ownerAccumulatedPercent: -1, updatedAt: -1 });

    const data = referrals.map(c => ({
      _id:               c._id,
      code:              c.code,
      active:            c.active,
      ownerName:         c.ownerName,
      ownerWhatsapp:     c.owner?.whatsapp || '',
      ownerAvgTicket:    c.ownerAvgTicket || 0,
      accumulatedPercent: c.ownerAccumulatedPercent || 0,
      validatedUses:     c.validatedUses || 0,
      totalUses:         c.totalUses || 0,
      ownerRedemptions:  c.ownerRedemptions || 0,
      rewardPerUse:      c.rewardPerUse || 0,
      discountForUser:   c.discountForUser,
      fraudFlags:        c.fraudFlags || [],
      // Usos validados recientes (últimos 5)
      recentUses: (c.uses || [])
        .filter(u => u.status === 'validated')
        .slice(-5)
        .map(u => ({ clientName: u.clientName, orderTotal: u.orderTotal, validatedAt: u.validatedAt }))
    }));

    res.json(data);
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

    // ── Anti-fraude: bloquear que el dueño use su propio cupón de referido ──
    if (coupon.type === 'referral' && coupon.blockedOwnerUse !== false) {
      const { isFraudAttempt } = require('../services/loyalty');
      const fraud = await isFraudAttempt(coupon, whatsapp);
      if (fraud) return res.status(400).json({ message: 'No podés usar tu propio cupón de referido' });
    }

    if (!coupon.unlimited) {
      const client = await Client.findOne({ whatsapp, active: true });
      if (client) {
        const existingOrder = await Order.findOne({
          coupon: coupon._id, client: client._id, status: { $ne: 'cancelled' }
        });
        if (existingOrder) return res.status(400).json({ message: 'Ya usaste este cupón anteriormente' });
      }
      if (coupon.singleUse) {
        const anyActiveOrder = await Order.findOne({ coupon: coupon._id, status: { $ne: 'cancelled' } });
        if (anyActiveOrder) return res.status(400).json({ message: 'Este cupón ya fue utilizado' });
      }
    }

    const response = {
      valid: true,
      code: coupon.code,
      discountPercent: coupon.discountForUser,
      ownerName: coupon.ownerName,
      message: `¡Cupón válido! Tenés ${coupon.discountForUser}% de descuento 🎉`
    };

    // Tope dinámico por ticket promedio del dueño
    if (coupon.ownerAvgTicket > 0) {
      response.maxDiscountAmount = Math.round(coupon.ownerAvgTicket * coupon.discountForUser / 100);
      response.message += ` (tope: ${response.maxDiscountAmount.toLocaleString('es-AR')})`;
    }

    // Cupón de producto específico
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

// ── POST canjear recompensa acumulada del dueño → genera cupón para él ────────
router.post('/:id/redeem', auth, adminOnly, async (req, res) => {
  try {
    const { redeemReferralReward } = require('../services/loyalty');
    const result = await redeemReferralReward(req.params.id);
    res.json({ success: true, ...result });
  } catch (err) { res.status(400).json({ message: err.message }); }
});

// ── POST enviar invitaciones de referido a clientes seleccionados ─────────────
router.post('/send-referral-invitations', auth, adminOnly, async (req, res) => {
  try {
    const { clientIds, message } = req.body;
    if (!clientIds?.length) return res.status(400).json({ message: 'Seleccioná al menos un cliente' });
    if (!message?.trim())  return res.status(400).json({ message: 'El mensaje no puede estar vacío' });
    const { sendReferralInvitations } = require('../services/loyalty');
    const results = await sendReferralInvitations(clientIds, message);
    const sent  = results.filter(r => r.status === 'enviado').length;
    const failed = results.filter(r => r.status !== 'enviado').length;
    res.json({ success: true, sent, failed, results });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── POST crear cupón de referido con cálculo de ticket promedio ───────────────
// Versión enriquecida: calcula ownerAvgTicket automáticamente
router.post('/referral', auth, adminOnly, async (req, res) => {
  try {
    const { ownerId, discountForUser, rewardPerUse, expiresAt } = req.body;
    const owner = await Client.findById(ownerId);
    if (!owner) return res.status(404).json({ message: 'Cliente no encontrado' });

    const { calcOwnerAvgTicket, generateCouponCode, friendlyName } = require('../services/loyalty');
    const avgTicket = await calcOwnerAvgTicket(ownerId);

    // Código unificado JB-APODO-X9
    const code = generateCouponCode(owner.nickname || owner.name?.split(' ')[0] || 'CLI');

    const existing = await Coupon.findOne({ code });
    if (existing) return res.status(400).json({ message: 'Código ya existe, intentá de nuevo' });

    const coupon = new Coupon({
      code,
      owner:           owner._id,
      ownerName:       owner.name,
      type:            'referral',
      discountForUser: discountForUser || 10,
      rewardPerUse:    rewardPerUse || 5,
      ownerAvgTicket:  avgTicket,
      unlimited:       true,
      blockedOwnerUse: true,
      active:          true,
      expiresAt:       expiresAt || null
    });
    await coupon.save();

    // ── WA automático al cliente con su código ─────────────────────────────────
    if (owner.whatsapp) {
      const { sendMessage } = require('../services/whatsapp');
      const friendly = friendlyName(owner);
      const disc     = discountForUser || 10;
      const reward   = rewardPerUse   || 5;
      const msg =
        `🎉 ¡Hola ${friendly}! Ya sos parte del sistema de referidos de *Janz Burgers* 🍔\n\n` +
        `Tu código personal es: *${code}*\n\n` +
        `📤 Compartilo con quien quieras. Cada amigo que lo use tiene un *${disc}% de descuento en su compra*.\n\n` +
        `🏆 Vos acumulás *${reward}%* de descuento por cada pedido válido de tus referidos.\n\n` +
        `Cuando acumulés suficiente te avisamos y generamos tu cupón de recompensa. 🎁\n\n` +
        `_Janz Burgers_ 🔥`;
      sendMessage(owner.whatsapp, msg)
        .catch(e => console.error('WA referido creado:', e.message));
    }

    res.status(201).json({ coupon, ownerAvgTicket: avgTicket });
  } catch (err) { res.status(400).json({ message: err.message }); }
});

module.exports = router;