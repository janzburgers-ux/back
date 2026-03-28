const express = require('express');
const router = express.Router();
const { Order } = require('../models/Order');
const { Client } = require('../models/Order');
const Config = require('../models/Config');
const { auth, kitchenOrAdmin, adminOnly } = require('../middleware/auth');
const { deductStockForOrder, returnStockForOrder, calcPackagingCost, autoUpdateProductAvailability } = require('../services/stock.service');
const { estimateWaitTime, getCurrentLoad, formatTimeAR } = require('../services/kitchen-capacity');
const { sendOrderReceived, sendOrderConfirmation, sendOrderReady, sendOrderCancelled } = require('../services/whatsapp');
const { addPointsForOrder, notifyReferralOwner, getReferralConfig } = require('../services/loyalty');
const { addProdePointsForOrder } = require('../services/prode.service');

// Horario operativo usando Config (fallback a env)
async function isOpen() {
  try {
    const cfg = await Config.findOne({ key: 'schedule' });
    const schedule = cfg?.value || { days: [5, 6, 0], openHour: 19, closeHour: 23 };
    // Ajustar a zona horaria de Argentina (UTC-3)
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
    const day = now.getDay();
    const hour = now.getHours();
    return schedule.days.map(Number).includes(day) && hour >= Number(schedule.openHour) && hour < Number(schedule.closeHour);
  } catch {
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
    return [5, 6, 0].includes(now.getDay());
  }
}

async function getTransferAlias() {
  try {
    const cfg = await Config.findOne({ key: 'transferAlias' });
    return cfg?.value || '';
  } catch { return ''; }
}


// GET carga actual de cocina
router.get('/kitchen-load', auth, async (req, res) => {
  try {
    const load = await getCurrentLoad();
    res.json(load);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// GET estimación de tiempo para un nuevo pedido
router.post('/estimate', auth, async (req, res) => {
  try {
    const { items } = req.body;
    const estimate = await estimateWaitTime(items || []);
    res.json({
      totalMinutes: estimate.totalMinutes,
      readyAt: estimate.readyAt,
      deliveryAt: estimate.deliveryAt,
      readyAtFormatted: formatTimeAR(estimate.readyAt),
      deliveryAtFormatted: formatTimeAR(estimate.deliveryAt),
      load: estimate.load,
      isSaturated: estimate.load.isSaturated
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// GET pedidos
router.get('/', auth, async (req, res) => {
  try {
    const { status, date, limit = 50 } = req.query;
    const filter = {};
    if (status) {
      const statuses = status.split(',').map(s => s.trim());
      filter.status = statuses.length > 1 ? { $in: statuses } : status;
    }
    if (date) {
      const start = new Date(date); start.setHours(0, 0, 0, 0);
      const end = new Date(date); end.setHours(23, 59, 59, 999);
      filter.createdAt = { $gte: start, $lte: end };
    }
    const orders = await Order.find(filter)
      .populate('client', 'name phone whatsapp')
      .populate('items.product', 'name variant salePrice')
      .sort({ createdAt: -1 })
      .limit(parseInt(limit));
    res.json(orders);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// GET estado del sistema (para /pedido público)
router.get('/system/status', async (req, res) => {
  const open = await isOpen();
  const today = new Date().getDay();
  const days = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
  res.json({
    open,
    today: days[today],
    message: open ? '🟢 Estamos abiertos. ¡Hacé tu pedido!' : '🔴 Cerrado por hoy.'
  });
});

// GET pedido individual
router.get('/:id', auth, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id).populate('client').populate('items.product');
    if (!order) return res.status(404).json({ message: 'Pedido no encontrado' });
    res.json(order);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// POST crear pedido (admin interno)
router.post('/', auth, async (req, res) => {
  try {
    const open = await isOpen();
    if (req.user.role !== 'admin' && !req.body.bypassOperationalCheck && !open) {
      return res.status(403).json({ message: 'Cerrado. No estamos tomando pedidos ahora.', closed: true });
    }

    const order = new Order(req.body);

    // Calcular costo de packaging automáticamente
    try {
      const { cost: packagingCost } = await calcPackagingCost(req.body.items || []);
      order.packagingCost = packagingCost;
    } catch {}

    await order.save();

    await Client.findByIdAndUpdate(req.body.client, { $inc: { totalOrders: 1 } });

    const populated = await Order.findById(order._id)
      .populate('client', 'name phone whatsapp')
      .populate('items.product', 'name variant');

    // Emitir a cocina via Socket.io
    const io = req.app.get('io');
    if (io) io.emit('new_order', populated);

    res.status(201).json(populated);
  } catch (err) { res.status(400).json({ message: err.message }); }
});

// PUT actualizar estado
router.put('/:id/status', auth, kitchenOrAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    const order = await Order.findById(req.params.id)
      .populate('client')
      .populate('items.product');

    if (!order) return res.status(404).json({ message: 'Pedido no encontrado' });

    const prevStatus = order.status;
    order.status = status;

    let stockResults = [];
    let whatsappResult = null;
    const alias = await getTransferAlias();

    // ── pending → confirmed ───────────────────────────────────────────────
    if (status === 'confirmed' && prevStatus === 'pending') {
      order.confirmedAt = new Date();

      // Guardar el tiempo confirmado por cocina (puede venir del body o usar el estimado)
      const confirmedMinutes = req.body.confirmedMinutes || order.estimatedMinutes || null;
      if (confirmedMinutes) order.confirmedMinutes = confirmedMinutes;

      if (!order.stockDeducted) {
        // Fallback: si por alguna razón no se descontó al recibir, descontar ahora
        stockResults = await deductStockForOrder(order.items);
        order.stockDeducted = true;
        autoUpdateProductAvailability().catch(e => console.error('Auto-availability error:', e.message));
      }

      if (order.client?.whatsapp) {
        whatsappResult = await sendOrderConfirmation(
          order.client.whatsapp,
          order.orderNumber,
          order.client.name,
          order.total,
          order.items,
          order.paymentMethod,
          order.couponCode,
          order.discountAmount,
          alias,
          order.publicCode,
          confirmedMinutes
        );
        order.whatsappSent = whatsappResult.success;
      }

      // Notificar al dueño del cupón de referido (si aplica)
      if (order.couponCode) {
        const Coupon = require('../models/Coupon');
        const coupon = await Coupon.findOne({ code: order.couponCode });
        if (coupon) {
          await Coupon.findByIdAndUpdate(coupon._id, {
            $push: {
              uses: {
                client: order.client._id,
                clientName: order.client.name,
                whatsapp: order.client.whatsapp,
                order: order._id,
                orderNumber: order.orderNumber,
                discountApplied: order.discountAmount,
                usedAt: new Date()
              }
            },
            $inc: { totalUses: 1 }
          });

          // Si es cupón de fidelización o de uso único → desactivar después del primer uso
          if (coupon.type === 'loyalty' || coupon.singleUse) {
            await Coupon.findByIdAndUpdate(coupon._id, { active: false });
          }

          const referralCfg = await getReferralConfig();
          if (referralCfg.enabled) {
            notifyReferralOwner(coupon, order.client.name, order.total)
              .catch(e => console.error('Error WA referido:', e.message));
          }
        }
      }

      // Prode: sumar puntos por compra si el período está activo
      addProdePointsForOrder(order.client._id, order._id, order.total)
        .catch(e => console.error('Prode points error:', e.message));
    }

    // ── preparing: guardar timestamp ─────────────────────────────────────
    if (status === 'preparing' && prevStatus === 'confirmed') {
      order.preparingAt = new Date();
    }

    // ── ready → Mensaje 3 ─────────────────────────────────────────────────
    if (status === 'ready' && prevStatus !== 'ready') {
      order.readyAt = new Date();
      if (order.client?.whatsapp) {
        sendOrderReady(
          order.client.whatsapp,
          order.orderNumber,
          order.client.name,
          order.deliveryType,
          order.total,
          order.paymentMethod,
          alias,
          order.publicCode
        ).catch(err => console.error('Error WA ready:', err.message));
      }
    }

    // ── cancelled: devolver stock + registrar rechazo + WA ───────────────
    if (status === 'cancelled') {
      order.status = 'cancelled';

      // Devolver stock si ya había sido descontado
      if (order.stockDeducted) {
        try {
          await returnStockForOrder(order.items);
          await Order.findByIdAndUpdate(order._id, { stockDeducted: false });
          autoUpdateProductAvailability().catch(e => console.error('Auto-availability error:', e.message));
        } catch (e) { console.error('Error devolviendo stock:', e.message); }
      }

      await order.save();

      // Registrar en hoja de rechazados
      try {
        const RejectedOrder = require('../models/RejectedOrder');
        const { reason, notes, missingStock } = req.body;
        await new RejectedOrder({
          orderNumber: order.orderNumber,
          publicCode: order.publicCode,
          client: { name: order.client?.name, whatsapp: order.client?.whatsapp, phone: order.client?.phone },
          items: order.items.map(i => ({ productName: i.productName, variant: i.variant, quantity: i.quantity })),
          total: order.total,
          reason: reason || 'sin_stock',
          notes: notes || '',
          missingStock: missingStock || []
        }).save();
      } catch (e) { console.error('Error guardando rechazo:', e.message); }

      if (order.client?.whatsapp) {
        sendOrderCancelled(order.client.whatsapp, order.client.name, order.publicCode, order.orderNumber)
          .catch(err => console.error('Error WA cancelado:', err.message));
      }
      const io = req.app.get('io');
      if (io) io.to(`order_${order.orderNumber}`).emit('order_status', { status: 'cancelled', order });
      return res.json({ order, cancelled: true });
    }

    // ── delivered ─────────────────────────────────────────────────────────
    if (status === 'delivered') {
      order.deliveredAt = new Date();
      await Client.findByIdAndUpdate(order.client._id, { $inc: { totalSpent: order.total } });

      // Sumar puntos de fidelización
      addPointsForOrder(order.client._id, order.total)
        .catch(e => console.error('Error puntos fidelización:', e.message));
    }

    await order.save();

    // Emitir actualización por Socket.io (cocina + cliente)
    const io = req.app.get('io');
    if (io) {
      io.emit('order_updated', { orderId: order._id, status, order });
      io.to(`order_${order.orderNumber}`).emit('order_status', { status, order });
    }

    res.json({ order, stockDeducted: stockResults, whatsappSent: whatsappResult });
  } catch (err) { res.status(400).json({ message: err.message }); }
});

// PUT actualizar orden general
router.put('/:id', auth, async (req, res) => {
  try {
    const order = await Order.findByIdAndUpdate(req.params.id, req.body, { new: true })
      .populate('client', 'name phone whatsapp')
      .populate('items.product');
    if (!order) return res.status(404).json({ message: 'Pedido no encontrado' });
    res.json(order);
  } catch (err) { res.status(400).json({ message: err.message }); }
});


// ── DELETE pedido con contraseña ──────────────────────────────────────────────
router.delete('/:id', auth, adminOnly, async (req, res) => {
  try {
    const { password } = req.body;
    const Config = require('../models/Config');
    const cfg = await Config.findOne({ key: 'deleteOrderPassword' });
    const deletePassword = cfg?.value || 'janz2024';
    if (password !== deletePassword) {
      return res.status(401).json({ message: 'Contraseña incorrecta' });
    }
    const order = await Order.findByIdAndDelete(req.params.id);
    if (!order) return res.status(404).json({ message: 'Pedido no encontrado' });
    res.json({ message: 'Pedido eliminado' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

module.exports = router;
