const express = require('express');
const router = express.Router();
const { Product } = require('../models/Product');
const { Client, Order } = require('../models/Order');
const Additional = require('../models/Additional');
const Coupon = require('../models/Coupon');
const Config = require('../models/Config');
const { sendOrderReceived } = require('../services/whatsapp');
const { calcPackagingCost, deductStockForOrder, autoUpdateProductAvailability } = require('../services/stock.service');
const { estimateWaitTime } = require('../services/kitchen-capacity');

// ── Helpers de timezone Argentina ─────────────────────────────────────────────
function nowAR() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
}

function todayRangeAR() {
  const ar = nowAR();
  const dateStr = `${ar.getFullYear()}-${String(ar.getMonth() + 1).padStart(2, '0')}-${String(ar.getDate()).padStart(2, '0')}`;
  return {
    start: new Date(dateStr + 'T00:00:00-03:00'),
    end:   new Date(dateStr + 'T23:59:59.999-03:00')
  };
}

// Horario desde Config
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

// GET menú público
router.get('/menu', async (req, res) => {
  try {
    const open = await isOpen();
    const products = await Product.find({ active: true }).sort('name variant');
    const additionals = await Additional.find({ active: true }).sort('name');

    const zonesCfg = await Config.findOne({ key: 'zones' });
    const zones = zonesCfg?.value || [{ id: 'default', name: 'Barrio La Rotonda', cost: 0, freeFrom: 0 }];

    const limitCfg = await Config.findOne({ key: 'orderLimits' });
    const limits = limitCfg?.value || { enabled: false, dailyMax: 50 };
    let todayCount = 0;
    let limitReached = false;
    if (limits.enabled) {
      const { start, end } = todayRangeAR();
      todayCount = await Order.countDocuments({ createdAt: { $gte: start, $lte: end }, status: { $ne: 'cancelled' } });
      limitReached = todayCount >= limits.dailyMax;
    }

    const businessCfg = await Config.findOne({ key: 'business' });
    const businessWhatsapp = businessCfg?.value?.whatsappNumber || '';

    // Agrupar productos por nombre
    const menu = products.reduce((acc, p) => {
      if (!acc[p.name]) acc[p.name] = [];
      acc[p.name].push({
        _id: p._id, name: p.name, variant: p.variant,
        salePrice: p.salePrice, available: p.available,
        image: p.image, description: p.description,
        productType: p.productType || 'burger'
      });
      return acc;
    }, {});

    res.json({ open, menu, additionals, zones, limits: { ...limits, todayCount, limitReached }, businessWhatsapp });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// POST crear pedido público
router.post('/order', async (req, res) => {
  try {
    const open = await isOpen();
    if (!open) {
      return res.status(403).json({ message: 'Estamos cerrados. Volvemos según nuestro horario.', closed: true });
    }

    // Límite diario (timezone Argentina)
    const limitCfg = await Config.findOne({ key: 'orderLimits' });
    const limits = limitCfg?.value || { enabled: false, dailyMax: 50 };
    if (limits.enabled) {
      const { start, end } = todayRangeAR();
      const todayCount = await Order.countDocuments({ createdAt: { $gte: start, $lte: end }, status: { $ne: 'cancelled' } });
      if (todayCount >= limits.dailyMax) {
        return res.status(403).json({
          message: `Alcanzamos el límite de pedidos del día (${limits.dailyMax}). ¡Gracias por tu interés! Volvé mañana.`,
          limitReached: true
        });
      }
    }

    const { client: clientData, items, paymentMethod, notes, deliveryType, couponCode, zone, scheduledFor, isScheduled } = req.body;

    // ── Validar cupón ──────────────────────────────────────────────────────────
    let couponDoc = null;
    let discountPercent = 0;
    let discountType = 'order';
    let discountAmount = 0;
    let applicableProductId = null;

    if (couponCode) {
      couponDoc = await Coupon.findOne({ code: couponCode.toUpperCase(), active: true });

      if (couponDoc) {
        // Verificar expiración
        if (couponDoc.expiresAt && new Date() > new Date(couponDoc.expiresAt)) {
          couponDoc = null; // cupón vencido
        }
      }

      if (couponDoc) {
        // Verificar si ya fue usado por este cliente en algún pedido NO cancelado
        if (!couponDoc.unlimited) {
          const existingOrder = await Order.findOne({
            coupon: couponDoc._id,
            'client': await (async () => {
              const c = await Client.findOne({ whatsapp: clientData.whatsapp, active: true });
              return c?._id || null;
            })(),
            status: { $ne: 'cancelled' }
          });

          if (existingOrder) {
            couponDoc = null; // ya lo usó en un pedido válido
          }
        }

        if (couponDoc) {
          // Cupón de uso único: verificar que no haya ningún pedido activo con él
          if (couponDoc.singleUse) {
            const anyActiveOrder = await Order.findOne({
              coupon: couponDoc._id,
              status: { $ne: 'cancelled' }
            });
            if (anyActiveOrder) {
              couponDoc = null; // ya fue usado
            }
          }
        }

        if (couponDoc) {
          discountPercent = couponDoc.discountForUser;
          // Cupón de producto específico
          if (couponDoc.applicableProduct) {
            discountType = 'product';
            applicableProductId = couponDoc.applicableProduct.toString();
          }
        }
      }
    }

    // ── Encontrar o crear cliente ──────────────────────────────────────────────
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

    // ── Construir ítems con precios ────────────────────────────────────────────
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
        product: product._id,
        productName: product.name,
        variant: product.variant,
        quantity: item.quantity,
        unitPrice: product.salePrice,
        additionals: resolvedAdditionals,
        notes: item.notes || ''
      });
    }

    // ── Calcular subtotal bruto ────────────────────────────────────────────────
    const subtotalBruto = orderItems.reduce((sum, item) => {
      const addsCost = (item.additionals || []).reduce((s, a) => s + a.unitPrice * (a.quantity || 1), 0);
      return sum + (item.unitPrice * item.quantity) + addsCost;
    }, 0);

    // ── Descuento ─────────────────────────────────────────────────────────────
    let hourlyDiscountApplied = false;
    const hourlyCfg = await Config.findOne({ key: 'hourlyDiscount' });
    const hDisc = hourlyCfg?.value;

    if (!couponDoc && hDisc?.enabled) {
      const now = nowAR();
      const nowStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      if (nowStr >= hDisc.fromHour && nowStr <= hDisc.toHour) {
        discountPercent = hDisc.discountPercent || 10;
        hourlyDiscountApplied = true;
      }
    }

    // Calcular discountAmount
    if (discountType === 'product' && applicableProductId && discountPercent > 0) {
      // Solo aplica a los ítems del producto específico
      const applicableItems = orderItems.filter(i => i.product.toString() === applicableProductId);
      const applicableSubtotal = applicableItems.reduce((sum, item) => {
        const addsCost = (item.additionals || []).reduce((s, a) => s + a.unitPrice * (a.quantity || 1), 0);
        return sum + (item.unitPrice * item.quantity) + addsCost;
      }, 0);
      discountAmount = Math.round(applicableSubtotal * discountPercent / 100);
    } else if (discountPercent > 0) {
      discountAmount = Math.round(subtotalBruto * discountPercent / 100);
    }

    const subtotalConDescuento = subtotalBruto - discountAmount;

    // ── Costo de delivery (verificar freeFrom DESPUÉS del descuento) ───────────
    let deliveryCost = 0;
    let zoneData = null;
    let deliveryMinutes = 15;

    if (zone && deliveryType === 'delivery') {
      const zonesCfg = await Config.findOne({ key: 'zones' });
      const zones = zonesCfg?.value || [];
      zoneData = zones.find(z => z.id === zone || z.name === zone);
      if (zoneData) {
        deliveryMinutes = zoneData.deliveryMinutes || 15;
        // IMPORTANTE: verificar freeFrom contra el subtotal YA DESCONTADO
        const isFree = zoneData.freeFrom > 0 && subtotalConDescuento >= zoneData.freeFrom;
        deliveryCost = isFree ? 0 : (zoneData.cost || 0);
      }
    } else if (deliveryType === 'takeaway') {
      const zonesCfg = await Config.findOne({ key: 'zones' });
      const zones = zonesCfg?.value || [];
      const minZone = zones.reduce((min, z) => (!min || (z.deliveryMinutes || 99) < (min.deliveryMinutes || 99)) ? z : min, null);
      deliveryMinutes = minZone?.deliveryMinutes || 10;
    }

    // ── Programación ──────────────────────────────────────────────────────────
    let scheduledDate = null;
    if (isScheduled && scheduledFor) {
      if (typeof scheduledFor === 'string' && /^\d{2}:\d{2}$/.test(scheduledFor)) {
        const ar = nowAR();
        const dateStr = `${ar.getFullYear()}-${String(ar.getMonth() + 1).padStart(2, '0')}-${String(ar.getDate()).padStart(2, '0')}`;
        scheduledDate = new Date(`${dateStr}T${scheduledFor}:00-03:00`);
      } else {
        scheduledDate = new Date(scheduledFor);
      }
    }

    // ── Crear pedido ──────────────────────────────────────────────────────────
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
      couponCode: couponDoc ? couponDoc.code : (hourlyDiscountApplied ? `HORARIO ${hDisc.fromHour}-${hDisc.toHour}` : null),
      discountPercent,
      discountAmount,
      discountType,
      status: 'pending',
      scheduledFor: scheduledDate,
      isScheduled: !!isScheduled
    });

    // Packaging automático
    try {
      const { cost: packagingCost } = await calcPackagingCost(orderItems);
      order.packagingCost = packagingCost;
    } catch {}

    // Estimación de tiempo
    try {
      const estimate = await estimateWaitTime(orderItems, null, deliveryMinutes);
      order.estimatedMinutes = estimate.totalMinutes;
    } catch {}

    await order.save();

    // Descontar stock
    try {
      await deductStockForOrder(order.items);
      await Order.findByIdAndUpdate(order._id, { stockDeducted: true });
      autoUpdateProductAvailability().catch(e => console.error('Auto-availability error:', e.message));
    } catch (e) {
      console.error('Error descontando stock:', e.message);
    }

    await Client.findByIdAndUpdate(client._id, { $inc: { totalOrders: 1 } });

    // NOTA: el registro del uso del cupón se hace SOLO al confirmar el pedido (orders.js)
    // para no contaminar el historial con pedidos que se cancelen.

    // WhatsApp mensaje 1
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
      discountPercent: order.discountPercent || 0,
      discountType: order.discountType || 'order',
      couponCode: order.couponCode || null,
      deliveryCost: order.deliveryCost || 0,
      items: order.items,
      estimatedMinutes: order.estimatedMinutes || null,
      message: `¡Pedido recibido! Tu código es ${order.publicCode || order.orderNumber}`
    });

  } catch (err) { res.status(400).json({ message: err.message }); }
});

module.exports = router;
