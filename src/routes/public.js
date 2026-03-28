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

// Horario desde Config
async function isOpen() {
  try {
    const cfg = await Config.findOne({ key: 'schedule' });
    const schedule = cfg?.value || { days: [5, 6, 0], openHour: '19:00', closeHour: '23:00' };
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
    const day = now.getDay();
    const nowStr = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
    // Compatibilidad: si viene como número, convertir a string
    const toTimeStr = v => {
      if (typeof v === 'string' && v.includes(':')) return v;
      return `${String(Number(v) || 0).padStart(2,'0')}:00`;
    };
    const openHour = toTimeStr(schedule.openHour);
    const closeHour = toTimeStr(schedule.closeHour);
    return schedule.days.map(Number).includes(day) && nowStr >= openHour && nowStr < closeHour;
  } catch {
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
    return [5, 6, 0].includes(now.getDay());
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

    // Límites de pedidos
    const limitCfg = await Config.findOne({ key: 'orderLimits' });
    const limits = limitCfg?.value || { enabled: false, dailyMax: 50 };
    let todayCount = 0;
    let limitReached = false;
    if (limits.enabled) {
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
      const { Order } = require('../models/Order');
      todayCount = await Order.countDocuments({ createdAt: { $gte: today, $lt: tomorrow }, status: { $ne: 'cancelled' } });
      limitReached = todayCount >= limits.dailyMax;
    }

    const businessCfg = await Config.findOne({ key: 'business' });
    const businessWhatsapp = businessCfg?.value?.whatsappNumber || '';

    const menu = products.reduce((acc, p) => {
      if (!acc[p.name]) acc[p.name] = [];
      acc[p.name].push({
        _id: p._id, name: p.name, variant: p.variant,
        salePrice: p.salePrice, available: p.available,
        image: p.image, description: p.description
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

    // Validar límite diario de pedidos
    const limitCfg = await Config.findOne({ key: 'orderLimits' });
    const limits = limitCfg?.value || { enabled: false, dailyMax: 50 };
    if (limits.enabled) {
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
      const todayCount = await require('../models/Order').Order.countDocuments({
        createdAt: { $gte: today, $lt: tomorrow },
        status: { $ne: 'cancelled' }
      });
      if (todayCount >= limits.dailyMax) {
        return res.status(403).json({ message: `Alcanzamos el límite de pedidos del día (${limits.dailyMax}). ¡Gracias por tu interés! Volvé mañana.`, limitReached: true });
      }
    }

    const { client: clientData, items, paymentMethod, notes, deliveryType, couponCode, zone } = req.body;

    // Validar cupón
    let couponDoc = null;
    let discountPercent = 0;
    if (couponCode) {
      couponDoc = await Coupon.findOne({ code: couponCode.toUpperCase(), active: true });
      if (couponDoc) {
        const alreadyUsed = couponDoc.uses.some(u => u.whatsapp === clientData.whatsapp);
        if (!alreadyUsed) discountPercent = couponDoc.discountForUser;
      }
    }

    // Encontrar o crear cliente
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

    // Construir ítems con precios
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

    // Costo de delivery de la zona
    let deliveryCost = 0;
    let zoneData = null;
    let deliveryMinutes = 15; // fallback default
    if (zone && deliveryType === 'delivery') {
      const zonesCfg = await Config.findOne({ key: 'zones' });
      const zones = zonesCfg?.value || [];
      zoneData = zones.find(z => z.id === zone || z.name === zone);
      if (zoneData) {
        deliveryCost = zoneData.cost || 0;
        deliveryMinutes = zoneData.deliveryMinutes || 15;
      }
    } else if (deliveryType === 'takeaway') {
      // Para takeaway usar la zona más cercana como referencia, o el mínimo disponible
      const zonesCfg = await Config.findOne({ key: 'zones' });
      const zones = zonesCfg?.value || [];
      const minZone = zones.reduce((min, z) => (!min || (z.deliveryMinutes || 99) < (min.deliveryMinutes || 99)) ? z : min, null);
      deliveryMinutes = minZone?.deliveryMinutes || 10;
    }


    // ── Descuento por franja horaria automático ─────────────────────────────
    // Se basa en la hora en que se HACE el pedido, no en la hora de entrega
    let hourlyDiscountApplied = false;
    const hourlyCfg = await Config.findOne({ key: 'hourlyDiscount' });
    const hDisc = hourlyCfg?.value;
    if (hDisc?.enabled) {
      // Hora actual en Argentina — momento exacto en que llega el pedido
      const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
      const nowStr = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
      // Verificar que esté dentro del rango configurado
      if (nowStr >= hDisc.fromHour && nowStr <= hDisc.toHour) {
        // Solo si no hay ya un cupón aplicado (no acumular descuentos)
        if (!couponCode) {
          discountPercent = hDisc.discountPercent || 10;
          hourlyDiscountApplied = true;
          console.log(`[HourlyDiscount] Aplicado ${discountPercent}% — pedido recibido a las ${nowStr} (rango: ${hDisc.fromHour}-${hDisc.toHour})`);
        }
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
      couponCode: couponDoc ? couponDoc.code : (hourlyDiscountApplied ? `HORARIO ${hDisc.fromHour}-${hDisc.toHour}` : null),
      discountPercent,
      status: 'pending'
    });

    // Packaging automático
    try {
      const { cost: packagingCost } = await calcPackagingCost(orderItems);
      order.packagingCost = packagingCost;
    } catch {}

    // Estimación de tiempo de cocina (cocción + delivery de la zona)
    try {
      const estimate = await estimateWaitTime(orderItems, null, deliveryMinutes);
      order.estimatedMinutes = estimate.totalMinutes;
    } catch {}

    await order.save();

    // ── Descontar stock al recibir el pedido ──────────────────────────────
    try {
      await deductStockForOrder(order.items);
      await Order.findByIdAndUpdate(order._id, { stockDeducted: true });
      autoUpdateProductAvailability().catch(e => console.error('Auto-availability error:', e.message));
    } catch (e) {
      console.error('Error descontando stock al recibir pedido:', e.message);
    }
    await Client.findByIdAndUpdate(client._id, { $inc: { totalOrders: 1 } });

    // Registrar uso del cupón
    if (couponDoc && discountPercent > 0) {
      couponDoc.uses.push({
        client: client._id, clientName: client.name, whatsapp: client.whatsapp,
        order: order._id, orderNumber: order.orderNumber, discountApplied: discountPercent
      });
      couponDoc.totalUses += 1;
      couponDoc.ownerPendingDiscount += couponDoc.rewardPerUse;
      await couponDoc.save();
    }

    // Mensaje 1: automático al recibir
    if (client.whatsapp) {
      sendOrderReceived(client.whatsapp, order.orderNumber, client.name, order.publicCode)
        .catch(err => console.error('Error WA received:', err.message));
    }

    // Emitir a cocina via Socket.io
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
      couponCode: order.couponCode || null,
      deliveryCost: order.deliveryCost || 0,
      items: order.items,
      estimatedMinutes: order.estimatedMinutes || null,
      message: `¡Pedido recibido! Tu código es ${order.publicCode || order.orderNumber}`
    });

  } catch (err) { res.status(400).json({ message: err.message }); }
});

module.exports = router;