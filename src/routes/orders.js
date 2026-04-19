const express = require('express');
const router = express.Router();
const { Order } = require('../models/Order');
const { Client } = require('../models/Order');
const Config = require('../models/Config');
const { auth, kitchenOrAdmin, adminOnly } = require('../middleware/auth');
const { deductStockForOrder, returnStockForOrder, calcPackagingCost, autoUpdateProductAvailability } = require('../services/stock.service');
const { estimateWaitTime, getCurrentLoad, formatTimeAR } = require('../services/kitchen-capacity');
const { sendOrderReceived, sendOrderConfirmation, sendOrderReady, sendOrderCancelled, sendReviewRequest } = require('../services/whatsapp');
const { addPointsForOrder, getReferralConfig, registerReferralUse, validateReferralUse, isFraudAttempt } = require('../services/loyalty');
const { addProdePointsForOrder } = require('../services/prode.service');

// ── Helpers ───────────────────────────────────────────────────────────────────
function nowAR() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
}

async function isOpen() {
  try {
    const cfg = await Config.findOne({ key: 'schedule' });
    const schedule = cfg?.value || { days: [5, 6, 0], openHour: '19:00', closeHour: '23:00' };
    const now = nowAR();
    const day = now.getDay();
    const nowStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const toTimeStr = v => {
      if (typeof v === 'string' && v.includes(':')) return v;
      return `${String(Number(v) || 0).padStart(2, '0')}:00`;
    };
    const openHour  = toTimeStr(schedule.openHour);
    const closeHour = toTimeStr(schedule.closeHour);
    return schedule.days.map(Number).includes(day) && nowStr >= openHour && nowStr < closeHour;
  } catch {
    return [5, 6, 0].includes(nowAR().getDay());
  }
}

async function getTransferAlias() {
  try {
    const cfg = await Config.findOne({ key: 'transferAlias' });
    return cfg?.value || '';
  } catch { return ''; }
}

// Parsear fecha en timezone Argentina
function parseARDate(dateStr) {
  // dateStr format: 'YYYY-MM-DD'
  return {
    start: new Date(dateStr + 'T00:00:00-03:00'),
    end:   new Date(dateStr + 'T23:59:59.999-03:00')
  };
}

// GET carga actual de cocina
router.get('/kitchen-load', auth, async (req, res) => {
  try {
    const load = await getCurrentLoad();
    res.json(load);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// GET estimación de tiempo
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
      // Filtrar por fecha en timezone Argentina — evita el bug del cambio de día a las 21hs (UTC)
      const { start, end } = parseARDate(date);
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
  const today = nowAR().getDay();
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

    try {
      const { cost: packagingCost } = await calcPackagingCost(req.body.items || []);
      order.packagingCost = packagingCost;
    } catch {}

    await order.save();
    await Client.findByIdAndUpdate(req.body.client, { $inc: { totalOrders: 1 } });

    const populated = await Order.findById(order._id)
      .populate('client', 'name phone whatsapp')
      .populate('items.product', 'name variant');

    const io = req.app.get('io');
    if (io) io.emit('new_order', populated);

    res.status(201).json(populated);
  } catch (err) { res.status(400).json({ message: err.message }); }
});

// POST crear pedido desde admin (equivalente a public/order pero con auth)
// Para tomar pedidos de clientes por WhatsApp
router.post('/admin-create', auth, adminOnly, async (req, res) => {
  try {
    const { Product } = require('../models/Product');
    const Additional = require('../models/Additional');
    const Coupon = require('../models/Coupon');
    const { client: clientData, items, paymentMethod, notes, deliveryType, couponCode, zone } = req.body;

    // Cupón
    let couponDoc = null;
    let discountPercent = 0;
    let discountType = 'order';
    let discountAmount = 0;
    let applicableProductId = null;

    if (couponCode) {
      couponDoc = await Coupon.findOne({ code: couponCode.toUpperCase(), active: true });
      if (couponDoc) {
        discountPercent = couponDoc.discountForUser;
        if (couponDoc.applicableProduct) {
          discountType = 'product';
          applicableProductId = couponDoc.applicableProduct.toString();
        }
      }
    }

    // Encontrar/crear cliente
    let client = await Client.findOne({ whatsapp: clientData.whatsapp, active: true });
    if (!client) {
      client = new Client({
        name: clientData.name,
        phone: clientData.phone || clientData.whatsapp,
        whatsapp: clientData.whatsapp,
        address: clientData.address,
        floor: clientData.floor,
        neighborhood: clientData.neighborhood,
        references: clientData.references,
        notes: clientData.notes
      });
      await client.save();
    } else {
      Object.assign(client, {
        address: clientData.address || client.address,
        floor: clientData.floor || client.floor,
        neighborhood: clientData.neighborhood || client.neighborhood,
        references: clientData.references || client.references
      });
      await client.save();
    }

    // Construir ítems
    const orderItems = [];
    for (const item of items) {
      const product = await Product.findById(item.product);
      if (!product) continue;
      const resolvedAdditionals = [];
      for (const a of (item.additionals || [])) {
        const add = await Additional.findById(a.additional);
        if (!add) continue;
        resolvedAdditionals.push({ additional: add._id, name: add.name, unitPrice: add.price, quantity: a.quantity || 1 });
      }
      orderItems.push({
        product: product._id, productName: product.name, variant: product.variant,
        quantity: item.quantity, unitPrice: product.salePrice,
        additionals: resolvedAdditionals,
        notes: item.notes || ''
      });
    }

    const subtotalBruto = orderItems.reduce((sum, item) => {
      const addsCost = (item.additionals || []).reduce((s, a) => s + a.unitPrice * (a.quantity || 1), 0);
      return sum + (item.unitPrice * item.quantity) + addsCost;
    }, 0);

    if (discountType === 'product' && applicableProductId && discountPercent > 0) {
      const applicableItems = orderItems.filter(i => i.product.toString() === applicableProductId);
      const appSubtotal = applicableItems.reduce((sum, item) => {
        const addsCost = (item.additionals || []).reduce((s, a) => s + a.unitPrice * (a.quantity || 1), 0);
        return sum + (item.unitPrice * item.quantity) + addsCost;
      }, 0);
      discountAmount = Math.round(appSubtotal * discountPercent / 100);
    } else if (discountPercent > 0) {
      discountAmount = Math.round(subtotalBruto * discountPercent / 100);
    }

    const subtotalConDescuento = subtotalBruto - discountAmount;

    let deliveryCost = 0;
    let zoneData = null;
    let deliveryMinutes = 15;
    if (zone && deliveryType === 'delivery') {
      const zonesCfg = await Config.findOne({ key: 'zones' });
      const zones = zonesCfg?.value || [];
      zoneData = zones.find(z => z.id === zone || z.name === zone);
      if (zoneData) {
        deliveryMinutes = zoneData.deliveryMinutes || 15;
        const isFree = zoneData.freeFrom > 0 && subtotalConDescuento >= zoneData.freeFrom;
        deliveryCost = isFree ? 0 : (zoneData.cost || 0);
      }
    }

    const order = new Order({
      client: client._id,
      items: orderItems,
      paymentMethod: paymentMethod || 'efectivo',
      deliveryType: deliveryType || 'delivery',
      deliveryAddress: `${clientData.address || ''}${clientData.floor ? ` ${clientData.floor}` : ''}${clientData.neighborhood ? `, ${clientData.neighborhood}` : ''}`,
      zone: zoneData ? zoneData.name : (zone || ''),
      deliveryCost,
      deliveryMinutes,
      notes,
      coupon: couponDoc ? couponDoc._id : null,
      couponCode: couponDoc ? couponDoc.code : null,
      discountPercent,
      discountAmount,
      discountType,
      status: 'pending',
      bypassOperationalCheck: true
    });

    try {
      const { cost: packagingCost } = await calcPackagingCost(orderItems);
      order.packagingCost = packagingCost;
    } catch {}

    try {
      const estimate = await estimateWaitTime(orderItems, null, deliveryMinutes);
      order.estimatedMinutes = estimate.totalMinutes;
    } catch {}

    await order.save();

    try {
      await deductStockForOrder(order.items);
      await Order.findByIdAndUpdate(order._id, { stockDeducted: true });
      autoUpdateProductAvailability().catch(e => console.error('Auto-availability error:', e.message));
    } catch (e) { console.error('Error descontando stock:', e.message); }

    await Client.findByIdAndUpdate(client._id, { $inc: { totalOrders: 1 } });

    if (client.whatsapp) {
      sendOrderReceived(client.whatsapp, order.orderNumber, client.name, order.publicCode)
        .catch(err => console.error('Error WA received:', err.message));
    }

    const populated = await Order.findById(order._id)
      .populate('client', 'name phone whatsapp')
      .populate('items.product', 'name variant');

    const io = req.app.get('io');
    if (io) io.emit('new_order', populated);

    res.status(201).json({
      success: true,
      orderNumber: order.orderNumber,
      publicCode: order.publicCode,
      total: order.total,
      discountAmount: order.discountAmount || 0,
      deliveryCost: order.deliveryCost || 0,
      items: order.items,
      message: `Pedido creado. Código: ${order.publicCode}`
    });
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

    // ── pending → confirmed ───────────────────────────────────────────────────
    if (status === 'confirmed' && prevStatus === 'pending') {
      order.confirmedAt = new Date();

      const confirmedMinutes = req.body.confirmedMinutes || order.estimatedMinutes || null;
      if (confirmedMinutes) order.confirmedMinutes = confirmedMinutes;

      if (!order.stockDeducted) {
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

      // Registrar uso del cupón al confirmar (estado: pending)
      // Para referidos: la recompensa al dueño se acumula SOLO al entregar (validated)
      if (order.coupon) {
        const Coupon = require('../models/Coupon');
        const coupon = await Coupon.findById(order.coupon);
        if (coupon) {
          const alreadyRecorded = coupon.uses.some(u => u.order?.toString() === order._id.toString());
          if (!alreadyRecorded) {
            if (coupon.type === 'referral') {
              // Referidos: registrar como pending, la validación y recompensa van al entregar
              await registerReferralUse(
                coupon._id, order.client._id, order.client.name, order.client.whatsapp,
                order._id, order.orderNumber, order.total, order.discountAmount
              );
            } else {
              // Otros cupones (admin, loyalty, product): registrar directamente
              await Coupon.findByIdAndUpdate(coupon._id, {
                $push: {
                  uses: {
                    client: order.client._id, clientName: order.client.name,
                    whatsapp: order.client.whatsapp, order: order._id,
                    orderNumber: order.orderNumber, orderTotal: order.total,
                    discountApplied: order.discountAmount, status: 'validated',
                    usedAt: new Date(), validatedAt: new Date()
                  }
                },
                $inc: { totalUses: 1, validatedUses: 1 }
              });
            }
          }

          // Cupón de 1 uso → desactivar
          if (coupon.type === 'loyalty' || coupon.singleUse) {
            await Coupon.findByIdAndUpdate(coupon._id, { active: false });
          }
        }
      }

      addProdePointsForOrder(order.client._id, order._id, order.total)
        .catch(e => console.error('Prode points error:', e.message));
    }

    // ── preparing ─────────────────────────────────────────────────────────────
    if (status === 'preparing' && prevStatus === 'confirmed') {
      order.preparingAt = new Date();
    }

    // ── ready ─────────────────────────────────────────────────────────────────
    if (status === 'ready' && prevStatus !== 'ready') {
      order.readyAt = new Date();
      if (order.client?.whatsapp) {
        sendOrderReady(
          order.client.whatsapp, order.orderNumber, order.client.name,
          order.deliveryType, order.total, order.paymentMethod, alias, order.publicCode
        ).catch(err => console.error('Error WA ready:', err.message));
      }
    }

    // ── cancelled: devolver stock + revertir cupón + registrar rechazo ────────
    if (status === 'cancelled') {
      order.status = 'cancelled';

      if (order.stockDeducted) {
        try {
          await returnStockForOrder(order.items);
          await Order.findByIdAndUpdate(order._id, { stockDeducted: false });
          autoUpdateProductAvailability().catch(e => console.error('Auto-availability error:', e.message));
        } catch (e) { console.error('Error devolviendo stock:', e.message); }
      }

      // ── REVERTIR USO DEL CUPÓN ────────────────────────────────────────────
      if (order.coupon) {
        try {
          const Coupon = require('../models/Coupon');
          const coupon = await Coupon.findById(order.coupon);
          if (coupon) {
            const hadUse = coupon.uses.some(u => u.order?.toString() === order._id.toString());
            if (hadUse) {
              // Quitar el registro de uso de este pedido
              await Coupon.findByIdAndUpdate(coupon._id, {
                $pull: { uses: { order: order._id } },
                $inc: { totalUses: -1 }
              });
              // Si era de 1 uso y fue desactivado, re-activar
              if ((coupon.singleUse || coupon.type === 'loyalty') && !coupon.active) {
                await Coupon.findByIdAndUpdate(coupon._id, { active: true });
              }
            }
          }
        } catch (e) { console.error('Error revirtiendo cupón:', e.message); }
      }

      await order.save();

      try {
        const RejectedOrder = require('../models/RejectedOrder');
        const { reason, notes: rNotes, missingStock } = req.body;
        await new RejectedOrder({
          orderNumber: order.orderNumber,
          publicCode: order.publicCode,
          client: { name: order.client?.name, whatsapp: order.client?.whatsapp, phone: order.client?.phone },
          items: order.items.map(i => ({ productName: i.productName, variant: i.variant, quantity: i.quantity })),
          total: order.total,
          reason: reason || 'sin_stock',
          notes: rNotes || '',
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

    // ── delivered ─────────────────────────────────────────────────────────────
    if (status === 'delivered') {
      order.deliveredAt = new Date();
      await Client.findByIdAndUpdate(order.client._id, { $inc: { totalSpent: order.total } });
      addPointsForOrder(order.client._id, order.total)
        .catch(e => console.error('Error puntos fidelización:', e.message));

      // ── Validar uso de cupón de referido → acumula recompensa al dueño ────
      // Solo se acumula cuando el pedido es ENTREGADO (no al confirmar)
      if (order.coupon) {
        validateReferralUse(order._id)
          .catch(e => console.error('Error validando referido:', e.message));
      }

      // ── Solicitar reseña con delay (configurable desde Config) ────────────
      if (order.client?.whatsapp && order.publicCode) {
        (async () => {
          try {
            const reviewCfg = await Config.findOne({ key: 'reviewSettings' });
            const settings  = reviewCfg?.value || {};
            // sendMode: 'auto' (default) | 'manual'
            // orderInterval: cada cuántos pedidos enviar (0 = todos, default 1)
            if (settings.enabled !== false && settings.sendMode !== 'manual') {
              // ── Verificar intervalo de pedidos ────────────────────────────
              const orderInterval = settings.orderInterval || 1;
              let shouldSend = true;
              if (orderInterval > 1) {
                // Contar pedidos entregados de este cliente
                const deliveredCount = await Order.countDocuments({
                  client: order.client._id,
                  status: 'delivered'
                });
                // El PRIMER pedido siempre envía; luego cada orderInterval pedidos
                shouldSend = deliveredCount === 1 || (deliveredCount % orderInterval === 0);
              }

              if (shouldSend) {
                const waitMs = ((settings.waitMinutes ?? 10) * 60 * 1000);
                setTimeout(async () => {
                  try {
                    const Review = require('../models/Review');
                    // Verificar que no se haya enviado ya el request para este pedido
                    const existing = await Review.findOne({ order: order._id });
                    if (!existing?.requestSent) {
                      // Crear placeholder SIN completed:true para no bloquear el formulario
                      await Review.findOneAndUpdate(
                        { order: order._id },
                        {
                          $setOnInsert: {
                            order:          order._id,
                            orderNumber:    order.orderNumber,
                            publicCode:     order.publicCode,
                            client:         order.client._id,
                            clientName:     order.client.name,
                            clientWhatsapp: order.client.whatsapp,
                            stars:          1,        // mínimo requerido por schema
                            requestSent:    true,
                            completed:      false     // NO completada aún por el cliente
                          }
                        },
                        { upsert: true, new: true }
                      );
                      await sendReviewRequest(order.client.whatsapp, order.client.name, order.publicCode);
                      await Review.findOneAndUpdate({ order: order._id }, { requestSent: true });
                    }
                  } catch (e) { console.error('Error enviando request de reseña:', e.message); }
                }, waitMs);
              }
            }
          } catch (e) { console.error('Error configurando review request:', e.message); }
        })();
      }
    }

    await order.save();

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

// DELETE pedido con contraseña
router.delete('/:id', auth, adminOnly, async (req, res) => {
  try {
    const { password } = req.body;
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