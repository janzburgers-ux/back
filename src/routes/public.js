const express = require('express');
const router = express.Router();
const { Product } = require('../models/Product');
const { Client, Order } = require('../models/Order');
const Additional = require('../models/Additional');
const Config = require('../models/Config');
const { sendOrderReceived, sendMessage } = require('../services/whatsapp');
const Review = require('../models/Review');
const Coupon = require('../models/Coupon');
const PinVerification = require('../models/PinVerification');
const { calcPackagingCost, reserveStockForOrder, deductStockForOrder, autoUpdateProductAvailability, autoUpdateAdditionalAvailability, autoUpdatePromoAvailability, broadcastAvailability } = require('../services/stock.service');
const Promo    = require('../models/Promo');
const { estimateWaitTime } = require('../services/kitchen-capacity');
// FIX timezone: centralizado en arDate.js — las copias locales tenían el
// timestamp UTC desfasado al usarlas en rangos de query a MongoDB.
const { nowAR, todayRangeAR, arDateStr } = require('../utils/arDate');

// ── Cache de menú en memoria (30s TTL) ───────────────────────────────────────
// FIX rendimiento: sin cache, cada apertura de la app hacía 6+ queries a Mongo.
// En picos de 20 clientes simultáneos = 120 queries en el mismo instante.
const menuCache = {
  data: null, expiresAt: 0, TTL: 30 * 1000,
  get()     { return Date.now() < this.expiresAt ? this.data : null; },
  set(data) { this.data = data; this.expiresAt = Date.now() + this.TTL; },
  clear()   { this.data = null; this.expiresAt = 0; },
};
module.exports.menuCache = menuCache;

async function getTodayOverride() {
  try {
    const cfg = await Config.findOne({ key: 'operationOverrides' });
    const overrides = cfg?.value || [];
    return overrides.find(o => o.date === arDateStr(nowAR())) || null;
  } catch { return null; }
}

async function isOpen() {
  try {
    const todayOverride = await getTodayOverride();

    // Excepción explícita: cerrado hoy sin importar el día
    if (todayOverride?.status === 'closed') return false;

    const cfg = await Config.findOne({ key: 'schedule' });
    const schedule = cfg?.value || { days: [5, 6, 0], openHour: '19:00', closeHour: '23:00' };
    const now = nowAR();
    const nowStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const toTimeStr = v => {
      if (typeof v === 'string' && v.includes(':')) return v;
      return `${String(Number(v) || 0).padStart(2, '0')}:00`;
    };
    const openHour  = toTimeStr(schedule.openHour);
    const closeHour = toTimeStr(schedule.closeHour);
    const withinHours = nowStr >= openHour && nowStr < closeHour;

    // Excepción explícita: abierto hoy (día normalmente cerrado), sólo chequea horario
    if (todayOverride?.status === 'open') return withinHours;

    // Comportamiento normal
    return schedule.days.map(Number).includes(now.getDay()) && withinHours;
  } catch {
    return [5, 6, 0].includes(nowAR().getDay());
  }
}

// ── Helper: nombre amistoso (nickname con fallback) ───────────────────────────
function friendlyName(client) {
  return client.nickname || client.name?.split(' ')[0] || 'Cliente';
}

// ── GET /api/public/client?wa=XXXX — lookup por WhatsApp ─────────────────────
// Solo devuelve datos necesarios para el form, sin info sensible de negocio
router.get('/client', async (req, res) => {
  try {
    const { wa } = req.query;
    if (!wa) return res.status(400).json({ message: 'WhatsApp requerido' });

    const client = await Client.findOne({ whatsapp: wa.replace(/\D/g, ''), active: true })
      .select('name nickname address floor neighborhood references birthDay birthMonth birthSkipped');

    if (!client) return res.json({ found: false });

    res.json({
      found:        true,
      name:         client.name || '',
      nickname:     client.nickname || '',
      address:      client.address || '',
      floor:        client.floor || '',
      neighborhood: client.neighborhood || '',
      references:   client.references || '',
      hasNickname:  !!client.nickname,
      hasBirth:     !!(client.birthDay && client.birthMonth),
      birthSkipped: !!client.birthSkipped
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── POST /api/public/send-pin — enviar PIN a cliente nuevo ───────────────────
router.post('/send-pin', async (req, res) => {
  try {
    const { wa } = req.body;
    if (!wa) return res.status(400).json({ message: 'WhatsApp requerido' });

    const cleanWa = wa.replace(/\D/g, '');

    // Generar PIN de 4 dígitos
    const pin = String(Math.floor(1000 + Math.random() * 9000));
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutos

    // Invalidar PINs previos del mismo WA
    await PinVerification.deleteMany({ wa: cleanWa });

    // Guardar nuevo PIN
    await PinVerification.create({ wa: cleanWa, pin, expiresAt });

    // Enviar WA
    const msg = `🔐 Tu código de verificación *Janz Burgers* es:\n\n*${pin}*\n\nExpira en 10 minutos. No lo compartas con nadie.\n\n_Janz Burgers_ 🍔`;
    await sendMessage(cleanWa, msg);

    res.json({ sent: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── POST /api/public/verify-pin — verificar PIN ───────────────────────────────
router.post('/verify-pin', async (req, res) => {
  try {
    const { wa, pin } = req.body;
    if (!wa || !pin) return res.status(400).json({ message: 'WA y PIN requeridos' });

    const cleanWa = wa.replace(/\D/g, '');
    const record = await PinVerification.findOne({ wa: cleanWa, used: false });

    if (!record) return res.status(400).json({ valid: false, message: 'PIN no encontrado o ya usado' });
    if (new Date() > record.expiresAt) return res.status(400).json({ valid: false, message: 'PIN expirado. Solicitá uno nuevo.' });
    if (record.pin !== String(pin)) return res.status(400).json({ valid: false, message: 'Código incorrecto' });

    // Marcar como usado
    await PinVerification.findByIdAndUpdate(record._id, { used: true });

    res.json({ valid: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── PATCH /api/public/client-update — actualizar nickname/cumple de cliente existente ──
router.patch('/client-update', async (req, res) => {
  try {
    const { wa, nickname, birthDay, birthMonth, birthSkipped } = req.body;
    if (!wa) return res.status(400).json({ message: 'WhatsApp requerido' });

    const cleanWa = wa.replace(/\D/g, '');
    const client = await Client.findOne({ whatsapp: cleanWa, active: true });
    if (!client) return res.status(404).json({ message: 'Cliente no encontrado' });

    if (nickname)            client.nickname     = nickname.trim();
    if (birthDay)            client.birthDay     = Number(birthDay);
    if (birthMonth)          client.birthMonth   = Number(birthMonth);
    if (birthSkipped)        client.birthSkipped = true;
    // Si dio cumple, asegurarse de que no quede skipped
    if (birthDay && birthMonth) client.birthSkipped = false;

    await client.save();
    res.json({ success: true, nickname: client.nickname });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// GET menú público
router.get('/menu', async (req, res) => {
  // Servir desde cache si está fresco (30s TTL)
  const cached = menuCache.get();
  if (cached) return res.json(cached);

  try {

    // ── Consultas independientes en paralelo ──────────────────────────────
    // Antes: isOpen(), products, additionals, 3x Config.findOne() y
    // Stock.find() se esperaban una por una (7 round-trips secuenciales a
    // Mongo). Ninguna depende del resultado de otra, así que se piden todas
    // juntas. Los 3 Config.findOne además se combinan en un solo find($in).
    // (La consulta de Stock se sacó de acá porque ahora vive adentro de
    // getLiveAvailability(), que se llama más abajo — evita duplicarla.)
    const [open, products, additionals, configDocs] = await Promise.all([
      isOpen(),
      Product.find({ active: true, visible: { $ne: false } }).sort('name variant').lean(),
      Additional.find({ active: true }).sort('name')
        .select('name description price emoji category appliesTo available ingredient consumesQuantity consumesUnit')
        .lean(),
      Config.find({ key: { $in: ['zones', 'orderLimits', 'business'] } }).lean(),
    ]);

    const configByKey = {};
    configDocs.forEach(c => { configByKey[c.key] = c.value; });

    const zones = configByKey.zones || [{ id: 'default', name: 'Barrio La Rotonda', cost: 0, freeFrom: 0 }];

    const limits = configByKey.orderLimits || { enabled: false, dailyMax: 50 };
    let todayCount = 0;
    let limitReached = false;
    if (limits.enabled) {
      const { start, end } = todayRangeAR();
      todayCount = await Order.countDocuments({ createdAt: { $gte: start, $lte: end }, status: { $ne: 'cancelled' } });
      limitReached = todayCount >= limits.dailyMax;
    }

    const businessWhatsapp = configByKey.business?.whatsappNumber || '';

    // ── Disponibilidad por producto: mismo motor que usa el panel admin y el ──
    // push en vivo por Socket.IO (services/stock.service.js::getLiveAvailability).
    // Antes acá se calculaba "stockWarning" de forma propia, aparte, mirando
    // solo si algún ingrediente estaba en 'low'/'out' sin importar cuántas
    // unidades quedaban realmente. Ahora es un único cálculo compartido, así
    // el número que ve el cliente al cargar la página es siempre el mismo que
    // el que después llega por el socket cuando se actualiza en vivo.
    const { getLiveAvailability } = require('../services/stock.service');
    const liveAvailability = await getLiveAvailability();
    const availabilityMap = {}; // productId -> { unitsAvailable, lowStock, available }
    liveAvailability.products.forEach(p => { availabilityMap[p.productId] = p; });

    // Agrupar productos por nombre (con stockWarning calculado)
    const menu = {};
    for (const p of products) {
      if (!menu[p.name]) menu[p.name] = [];
      const live = availabilityMap[p._id.toString()];
      const stockWarning = !!live?.lowStock;
      menu[p.name].push({
        _id: p._id, name: p.name, variant: p.variant,
        salePrice: p.salePrice, available: p.available,
        image: p.image, description: p.description,
        productType: p.productType || 'burger',
        isDailyBurger:   !!p.isDailyBurger,
        isMonthlyBurger: !!p.isMonthlyBurger,
        stockWarning
      });
    }

    const anyLowStock = liveAvailability.products.some(p => p.lowStock || p.available === false);

    // ── Promos activas y disponibles ──────────────────────────────────────────
    const promosDocs = await Promo.find({ active: true }).populate('components.product', 'name variant salePrice image available active');
    const promos = promosDocs
      .filter(p => p.available)
      .map(p => ({
        _id:         p._id,
        name:        p.name,
        description: p.description,
        salePrice:   p.salePrice,
        image:       p.image,
        available:   p.available,
        components:  p.components.map(c => ({
          product:  c.product?._id,
          name:     c.product?.name,
          variant:  c.product?.variant,
          quantity: c.quantity,
        })),
      }));

    // ── Hamburguesa del día y del mes (desde campos del producto) ──────────
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
    const nowStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    // Hamburguesa del día: buscar producto activo marcado como tal
    const dailyProduct = products.find(p => p.isDailyBurger && p.active && p.visible !== false);
    let activeDailyDeal = null;
    if (dailyProduct) {
      const from = dailyProduct.dailyFromHour || '00:00';
      const to   = dailyProduct.dailyToHour   || '23:59';
      if (nowStr >= from && nowStr <= to) {
        activeDailyDeal = {
          enabled:        true,
          productId:      dailyProduct._id,
          name:           dailyProduct.name + (dailyProduct.variant ? ` ${dailyProduct.variant}` : ''),
          description:    dailyProduct.description || '',
          image:          dailyProduct.image || '',
          originalPrice:  dailyProduct.salePrice,
          discountPrice:  dailyProduct.dailyDiscountPrice || dailyProduct.salePrice,
          discountPercent: dailyProduct.dailyDiscountPrice
            ? Math.round((1 - dailyProduct.dailyDiscountPrice / dailyProduct.salePrice) * 100)
            : 0,
          fromHour: from,
          toHour:   to
        };
      }
    }

    // Hamburguesa del mes: buscar producto activo marcado como tal
    const monthlyProduct = products.find(p => p.isMonthlyBurger && p.active && p.visible !== false);
    const activeMonthlyBurger = monthlyProduct ? {
      enabled:     true,
      productId:   monthlyProduct._id,
      name:        monthlyProduct.name + (monthlyProduct.variant ? ` ${monthlyProduct.variant}` : ''),
      description: monthlyProduct.description || '',
      image:       monthlyProduct.image || '',
      price:       monthlyProduct.salePrice,
      badge:       '🏆 Del mes',
      month:       monthlyProduct.monthlyLabel || ''
    } : null;

    // Excepción del día (para mensajes personalizados en el banner)
    const todayOverride = await getTodayOverride();

    const menuResponse = { open, menu, additionals, zones, limits: { ...limits, todayCount, limitReached }, businessWhatsapp, dailyDeal: activeDailyDeal, monthlyBurger: activeMonthlyBurger, todayOverride, anyLowStock, promos };
    if (open && !limitReached) menuCache.set(menuResponse);
    res.json(menuResponse);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// POST crear pedido público
router.post('/order', async (req, res) => {
  try {
    const open = await isOpen();
    if (!open) {
      return res.status(403).json({ message: 'Estamos cerrados. Volvemos según nuestro horario.', closed: true });
    }

    // ── Anti-duplicados: idempotency key ──────────────────────────────────────
    // El frontend genera un key único por intento de checkout y lo guarda en
    // sessionStorage. Si hay un corte de internet y el cliente reintenta, manda
    // el mismo key → devolvemos el pedido ya creado sin crear uno nuevo.
    const { idempotencyKey } = req.body;
    if (idempotencyKey) {
      const existing = await Order.findOne({ idempotencyKey, status: { $ne: 'cancelled' } })
        .select('orderNumber publicCode status total');
      if (existing) {
        return res.json({
          _id:                existing._id,
          orderNumber:        existing.orderNumber,
          publicCode:         existing.publicCode,
          status:             existing.status,
          total:              existing.total,
          _idempotentResponse: true   // flag para que el frontend lo sepa si lo necesita
        });
      }
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

    const { client: clientData, items: rawItems, paymentMethod, notes, deliveryType, couponCode, zone, scheduledFor, isScheduled, idempotencyKey: iKey, acceptPartial } = req.body;

    // ── Determinar qué items procesar ──────────────────────────────────────────
    // Si viene acceptPartial=true, el frontend ya filtró los items confirmados (adjustedItems)
    // y los mandó como `items`. Saltear la reserva previa y crear el pedido directo.
    const items = rawItems;

    // ── Expandir ítems de promo en productos individuales (para stock) ────────
    // Las promos se envían como { promo: id, quantity: N }. Para reservar stock
    // y crear el pedido, se expanden en sus componentes como si fueran pedidos normales.
    const expandedItems = [];
    for (const item of items) {
      if (item.promo) {
        const promo = await Promo.findById(item.promo).populate('components.product');
        if (!promo || !promo.active || !promo.available) {
          return res.status(400).json({ message: `La promo "${promo?.name || item.promo}" ya no está disponible.` });
        }
        for (const c of promo.components) {
          expandedItems.push({
            product:     c.product._id,
            productName: c.product.name,
            variant:     c.product.variant,
            quantity:    c.quantity * item.quantity,
            unitPrice:   0, // el precio de la promo ya está en el total
            additionals: [],
            _fromPromo:  promo._id,
            _promoName:  promo.name,
            _promoPrice: promo.salePrice * item.quantity,
            _promoQty:   item.quantity,
          });
        }
      } else {
        expandedItems.push(item);
      }
    }

    // ── Reserva atómica de stock (Fase 1 — solo si no es confirmación parcial) ──
    if (!acceptPartial) {
      const itemsForReserve = [];
      for (const item of expandedItems) {
        const product = await Product.findById(item.product);
        if (!product || !product.active || !product.available) {
          const resolvedAdds = [];
          for (const a of (item.additionals || [])) {
            const add = await Additional.findById(a.additional);
            if (add) resolvedAdds.push({ additional: add._id, name: add.name, unitPrice: add.price, quantity: a.quantity || 1 });
          }
          const unitPrice = (product?.isDailyBurger && product?.dailyDiscountPrice > 0)
            ? product.dailyDiscountPrice : (product?.salePrice || 0);
          itemsForReserve.push({ product: item.product, productName: product?.name || 'Producto', variant: product?.variant || '', quantity: item.quantity, unitPrice, additionals: resolvedAdds });
        } else {
          const resolvedAdds = [];
          for (const a of (item.additionals || [])) {
            const add = await Additional.findById(a.additional);
            if (add) resolvedAdds.push({ additional: add._id, name: add.name, unitPrice: add.price, quantity: a.quantity || 1 });
          }
          const unitPrice = (product.isDailyBurger && product.dailyDiscountPrice > 0)
            ? product.dailyDiscountPrice : product.salePrice;
          itemsForReserve.push({ product: item.product, productName: product.name, variant: product.variant, quantity: item.quantity, unitPrice, additionals: resolvedAdds });
        }
      }

      const reservation = await reserveStockForOrder(itemsForReserve);

      if (!reservation.ok) {
        // Si todos los items fallaron, no hay nada que ofrecer parcialmente
        if (reservation.adjustedItems.length === 0) {
          return res.status(409).json({
            stockIssue: true,
            unavailableItems: reservation.unavailableItems,
            adjustedItems: [],
            adjustedTotal: 0,
            message: 'No tenemos stock disponible para ninguno de los productos de tu pedido.'
          });
        }
        // Algunos items fallaron → devolver para que el cliente confirme el parcial
        return res.status(409).json({
          stockIssue: true,
          unavailableItems: reservation.unavailableItems,
          adjustedItems: reservation.adjustedItems,
          adjustedTotal: reservation.adjustedTotal,
          message: 'Algunos productos no tienen stock disponible. ¿Confirmás el pedido con lo que hay?'
        });
      }
      // Stock reservado OK — el pedido se crea a continuación y el stock ya está descontado
    }

    // ── Validar cupón ──────────────────────────────────────────────────────────
    let couponDoc = null;
    let discountPercent = 0;
    let discountMode = 'percent';
    let fixedAmount = 0;
    let discountType = 'order';
    let discountAmount = 0;
    let applicableProductId = null;
    let variantQuantity = 1;
    // Trazabilidad: si el cliente mandó un couponCode pero terminó sin aplicarse,
    // acá queda por qué — para que no se pierda en silencio (ver Order.couponAttempted).
    let couponRejectionReason = null;

    if (couponCode) {
      const { checkCouponEligibility } = require('../services/coupon.service');
      couponDoc = await Coupon.findOne({ code: couponCode.toUpperCase(), active: true });

      if (!couponDoc) {
        couponRejectionReason = 'inactive';
      } else {
        const eligibility = await checkCouponEligibility(couponDoc, clientData.whatsapp);
        if (!eligibility.ok) {
          couponRejectionReason = eligibility.reason;
          couponDoc = null;
        }
      }

      if (couponDoc) {
        // FIX race condition: findOneAndUpdate atómico reemplaza el read-then-check
        // no atómico. Dos pedidos concurrentes con el mismo cupón ya no pueden
        // pasar ambos — solo uno puede marcar active=false exitosamente.
        if (couponDoc.singleUse) {
          const locked = await Coupon.findOneAndUpdate(
            { _id: couponDoc._id, active: true },
            { $set: { active: false, _lockReservedAt: new Date() } },
            { new: false }
          );
          if (!locked) {
            couponDoc = null;
            couponRejectionReason = 'singleUseTaken';
          }
        }
      }

      if (couponDoc) {
        discountPercent = couponDoc.discountForUser;
        discountMode = couponDoc.discountMode || 'percent';
        fixedAmount = couponDoc.fixedAmount || 0;
        if (couponDoc.applicableProduct) {
          discountType = 'product';
          applicableProductId = couponDoc.applicableProduct.toString();
        }
        if (couponDoc.applicableVariant) {
          discountType = 'variant';
          variantQuantity = couponDoc.variantQuantity || 1;
        }
      }
    }

    // ── Encontrar o crear cliente ──────────────────────────────────────────────
    let client = await Client.findOne({ whatsapp: clientData.whatsapp, active: true });
    if (!client) {
      client = new Client({
        name:         clientData.name,
        nickname:     clientData.nickname?.trim() || '',
        phone:        clientData.phone || clientData.whatsapp,
        whatsapp:     clientData.whatsapp,
        address:      clientData.address,
        floor:        clientData.floor,
        neighborhood: clientData.neighborhood,
        references:   clientData.references,
        notes:        clientData.notes,
        birthDay:     clientData.birthDay     ? Number(clientData.birthDay)   : undefined,
        birthMonth:   clientData.birthMonth   ? Number(clientData.birthMonth) : undefined,
        birthSkipped: clientData.birthSkipped ? true                          : false,
      });
      await client.save();
    } else {
      // Actualizar dirección siempre
      if (clientData.address)      client.address      = clientData.address;
      if (clientData.floor != null) client.floor        = clientData.floor;
      if (clientData.neighborhood) client.neighborhood  = clientData.neighborhood;
      if (clientData.references)   client.references    = clientData.references;
      // Solo actualizar nickname si aún no tiene uno
      if (clientData.nickname && !client.nickname) client.nickname = clientData.nickname.trim();
      // Solo actualizar cumple si aún no tiene y el cliente lo dio
      if (!client.birthDay && clientData.birthDay)   client.birthDay   = Number(clientData.birthDay);
      if (!client.birthMonth && clientData.birthMonth) client.birthMonth = Number(clientData.birthMonth);
      // Registrar si saltó el cumple (solo si no tiene ya un cumple registrado)
      if (clientData.birthSkipped && !client.birthDay) client.birthSkipped = true;
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
      // Si es la burger del día con precio especial, usar dailyDiscountPrice
      const unitPrice = (product.isDailyBurger && product.dailyDiscountPrice > 0)
        ? product.dailyDiscountPrice
        : product.salePrice;

      orderItems.push({
        product: product._id,
        productName: product.name,
        variant: product.variant,
        quantity: item.quantity,
        unitPrice,
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
    if (discountType === 'product' && applicableProductId && (discountPercent > 0 || (discountMode === 'fixed' && fixedAmount > 0))) {
      // Solo aplica a los ítems del producto específico
      const applicableItems = orderItems.filter(i => i.product.toString() === applicableProductId);
      const applicableSubtotal = applicableItems.reduce((sum, item) => {
        const addsCost = (item.additionals || []).reduce((s, a) => s + a.unitPrice * (a.quantity || 1), 0);
        return sum + (item.unitPrice * item.quantity) + addsCost;
      }, 0);
      discountAmount = discountMode === 'fixed'
        ? Math.min(fixedAmount, applicableSubtotal) // topeado: nunca deja ese producto en negativo
        : Math.round(applicableSubtotal * discountPercent / 100);
    } else if (discountType === 'variant' && couponDoc?.applicableVariant && (discountPercent > 0 || (discountMode === 'fixed' && fixedAmount > 0))) {
      // Cupón restringido a variante (ej: "doble", cualquier sabor) — se puede
      // combinar con applicableProductId (ej: "solo Doble Janz") o no (cualquier
      // producto de esa variante). Descuenta solo `variantQuantity` unidades: se
      // eligen siempre las más baratas primero para proteger el margen, y el
      // descuento se calcula SOLO sobre el precio de la hamburguesa — nunca
      // sobre los adicionales que el cliente le haya agregado a esa unidad.
      const variantLower = couponDoc.applicableVariant.toLowerCase();
      let matching = orderItems.filter(i => (i.variant || '').toLowerCase() === variantLower);
      if (applicableProductId) matching = matching.filter(i => i.product.toString() === applicableProductId);

      // Expandir por cantidad: cada unidad del ítem entra por separado al pool
      const units = [];
      matching.forEach(i => { for (let k = 0; k < i.quantity; k++) units.push(i.unitPrice); });
      units.sort((a, b) => a - b); // más baratas primero

      const selected = units.slice(0, variantQuantity);
      const selectedSubtotal = selected.reduce((s, p) => s + p, 0);
      discountAmount = discountMode === 'fixed'
        ? Math.min(fixedAmount, selectedSubtotal)
        : Math.round(selectedSubtotal * discountPercent / 100);
    } else if (discountMode === 'fixed' && fixedAmount > 0) {
      // Monto fijo sobre todo el pedido — topeado al subtotal (si el cupón vale
      // más que el pedido, se paga $0, nunca queda un total negativo)
      discountAmount = Math.min(fixedAmount, subtotalBruto);
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
      // Si mandó un código y no se aplicó, queda registrado acá (ver services/coupon.service.js)
      couponAttempted: (couponCode && !couponDoc) ? couponCode.toUpperCase() : null,
      couponRejectionReason: (couponCode && !couponDoc) ? couponRejectionReason : null,
      discountPercent,
      discountAmount,
      discountType,
      status: 'pending',
      scheduledFor: scheduledDate,
      isScheduled: !!isScheduled,
      idempotencyKey: iKey || null
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
    // Si no es acceptPartial, la reserva atómica ya lo descontó → solo marcar stockDeducted
    // Si es acceptPartial, los items vienen confirmados → descontar normalmente
    try {
      if (acceptPartial) {
        await deductStockForOrder(order.items);
      }
      await Order.findByIdAndUpdate(order._id, { stockDeducted: true });
      await autoUpdateProductAvailability();
      await autoUpdateAdditionalAvailability();
      await autoUpdatePromoAvailability();
      broadcastAvailability(req.app.get('io')).catch(() => {});
    } catch (e) {
      console.error('Error descontando stock:', e.message);
    }

    await Client.findByIdAndUpdate(client._id, { $inc: { totalOrders: 1 } });

    // NOTA: el registro del uso del cupón se hace SOLO al confirmar el pedido (orders.js)
    // para no contaminar el historial con pedidos que se cancelen.

    // WhatsApp mensaje 1
    if (client.whatsapp) {
      sendOrderReceived(client.whatsapp, order.orderNumber, friendlyName(client), order.publicCode)
        .catch(err => console.error('Error WA received:', err.message));
    }

    const populated = await Order.findById(order._id)
      .populate('client', 'name phone whatsapp')
      .populate('items.product', 'name variant');

    const io = req.app.get('io');
    if (io) io.emit('new_order', populated);

    res.status(201).json({
      success: true,
      _id: order._id,
      orderNumber: order.orderNumber,
      publicCode: order.publicCode,
      total: order.total,
      discountAmount: order.discountAmount || 0,
      discountPercent: order.discountPercent || 0,
      discountType: order.discountType || 'order',
      couponCode: order.couponCode || null,
      // Aviso explícito si el cliente intentó un cupón y no se pudo aplicar,
      // en vez de que se entere recién cuando llega el WhatsApp de confirmación.
      couponRejected: !!order.couponAttempted,
      couponRejectionMessage: order.couponAttempted
        ? 'Tu cupón no pudo aplicarse a este pedido, por eso el total no tiene descuento.'
        : null,
      deliveryCost: order.deliveryCost || 0,
      items: order.items,
      estimatedMinutes: order.estimatedMinutes || null,
      message: `¡Pedido recibido! Tu código es ${order.publicCode || order.orderNumber}`
    });

  } catch (err) { res.status(400).json({ message: err.message }); }
});


// ── GET reseña pendiente (verifica que el pedido existe y no fue reseñado aún) ──
router.get('/review/:publicCode', async (req, res) => {
  try {
    const { Order: OrderModel } = require('../models/Order');
    const order = await OrderModel.findOne({ publicCode: req.params.publicCode })
      .populate('client', 'name');

    if (!order) return res.status(404).json({ message: 'Pedido no encontrado' });
    if (order.status !== 'delivered') return res.status(400).json({ message: 'El pedido todavía no fue entregado' });

    // Verificar si ya dejó reseña (completed=true para no confundir con el placeholder de requestSent)
    const existing = await Review.findOne({ order: order._id, completed: true });
    if (existing) return res.json({ alreadyReviewed: true, stars: existing.stars });

    // Config de incentivo
    const reviewCfg = await Config.findOne({ key: 'reviewSettings' });
    const settings  = reviewCfg?.value || {};

    res.json({
      alreadyReviewed: false,
      orderNumber: order.orderNumber,
      clientName:  order.client?.name || '',
      incentive: {
        type:        settings.incentiveType  || 'none',
        percent:     settings.discountPercent || 10,
        productName: settings.productName     || '',
        validDays:   settings.validDays       || 30
      }
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── POST guardar reseña y generar incentivo ────────────────────────────────────
router.post('/review/:publicCode', async (req, res) => {
  try {
    const { Order: OrderModel, Client: ClientModel } = require('../models/Order');
    const { stars, burgerRating, tempRating, onTime, comment, npsScore } = req.body;

    if (!stars || stars < 1 || stars > 5) return res.status(400).json({ message: 'Calificación inválida' });

    const order = await OrderModel.findOne({ publicCode: req.params.publicCode })
      .populate('client', 'name whatsapp');
    if (!order) return res.status(404).json({ message: 'Pedido no encontrado' });

    // Idempotente: si ya completó la reseña, no duplicar
    const existing = await Review.findOne({ order: order._id, completed: true });
    if (existing) return res.json({ alreadyReviewed: true });

    // Config de incentivo
    const reviewCfg = await Config.findOne({ key: 'reviewSettings' });
    const settings  = reviewCfg?.value || {};

    // Crear o actualizar la reseña
    const reviewData = {
      order:          order._id,
      orderNumber:    order.orderNumber,
      publicCode:     order.publicCode,
      client:         order.client?._id,
      clientName:     order.client?.name,
      clientWhatsapp: order.client?.whatsapp,
      stars: Number(stars),
      burgerRating: burgerRating || '',
      tempRating:   tempRating   || '',
      onTime:       onTime != null ? Boolean(onTime) : null,
      comment:      comment       || '',
      npsScore:     npsScore      ? Number(npsScore) : null,
      requestSent:  true,
      completed:    true  // marca que el cliente completó el formulario (diferencia del placeholder)
    };

    // Generar incentivo si corresponde
    let couponCode = null;
    let couponDoc  = null;
    if (settings.incentiveType && settings.incentiveType !== 'none') {
      const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
      const suffix = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
      couponCode = `GRACIAS-${suffix}`;

      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + (settings.validDays || 30));

      const couponData = {
        code: couponCode,
        type: 'loyalty',         // tipo válido en el enum del schema
        owner: order.client._id, // ← campo REQUERIDO que faltaba — sin esto el save falla silenciosamente
        ownerName: order.client?.name || '',
        active: true,
        unlimited: false,
        singleUse: true,
        expiresAt,
        discountForUser: settings.incentiveType === 'discount' ? (settings.discountPercent || 10) : 100,
        applicableProduct: settings.incentiveType === 'product' && settings.productId
          ? settings.productId
          : null,
        uses: []
      };

      try {
        couponDoc = await Coupon.create(couponData);
        reviewData.incentiveType   = settings.incentiveType;
        reviewData.couponGenerated = couponCode;
        reviewData.couponId        = couponDoc._id;
        reviewData.incentiveSent   = true;
      } catch (e) { console.error('Error creando cupón de reseña:', e.message); }
    }

    // Usar findOneAndUpdate + upsert para evitar errores de validacion
    // con registros placeholder que puedan tener stars fuera del rango valido.
    const review = await Review.findOneAndUpdate(
      { order: order._id },
      { $set: reviewData },
      { upsert: true, new: true, runValidators: true }
    );

    res.json({
      success: true,
      stars: review.stars,
      incentive: couponCode ? {
        code:      couponCode,
        type:      settings.incentiveType,
        percent:   settings.discountPercent || 10,
        validDays: settings.validDays || 30
      } : null
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── PUT /public/order/:id/cancel — cliente cancela su propio pedido ──────────
router.put('/order/:id/cancel', async (req, res) => {
  try {
    const { publicCode } = req.body;
    if (!publicCode) return res.status(400).json({ message: 'Código de pedido requerido.' });

    const { Order } = require('../models/Order');
    const order = await Order.findById(req.params.id).populate('client');
    if (!order) return res.status(404).json({ message: 'Pedido no encontrado.' });

    // Verificar que el publicCode coincida (el cliente ya lo tiene)
    if (order.publicCode !== publicCode) {
      return res.status(403).json({ message: 'Código incorrecto.' });
    }

    // Solo se puede cancelar si está en 'pending'
    if (order.status !== 'pending') {
      return res.status(409).json({
        message: 'Tu pedido ya está en preparación. Si necesitás cancelarlo, contactanos por WhatsApp.',
        alreadyConfirmed: true
      });
    }

    order.status = 'cancelled';

    // Devolver stock si ya se había descontado
    if (order.stockDeducted) {
      try {
        const { returnStockForOrder, autoUpdateProductAvailability, autoUpdateAdditionalAvailability, autoUpdatePromoAvailability, broadcastAvailability } = require('../services/stock.service');
        await returnStockForOrder(order.items);
        await Order.findByIdAndUpdate(order._id, { stockDeducted: false });
        await autoUpdateProductAvailability();
        await autoUpdateAdditionalAvailability();
        await autoUpdatePromoAvailability();
        broadcastAvailability(req.app.get('io')).catch(() => {});
      } catch (e) { console.error('Error devolviendo stock (cancel cliente):', e.message); }
    }

    // Revertir cupón si había uno
    if (order.coupon) {
      try {
        const Coupon = require('../models/Coupon');
        const coupon = await Coupon.findById(order.coupon);
        if (coupon) {
          const hadUse = coupon.uses.some(u => u.order?.toString() === order._id.toString());
          if (hadUse) {
            await Coupon.findByIdAndUpdate(coupon._id, {
              $pull: { uses: { order: order._id } },
              $inc: { totalUses: -1 }
            });
            if ((coupon.singleUse || coupon.type === 'loyalty') && !coupon.active) {
              await Coupon.findByIdAndUpdate(coupon._id, { active: true });
            }
          }
        }
      } catch (e) { console.error('Error revirtiendo cupón (cancel cliente):', e.message); }
    }

    await order.save();

    // FIX: decrementar totalOrders al cancelar (un pedido cancelado no es una compra real)
    if (order.client?._id) {
      await Client.findByIdAndUpdate(order.client._id, { $inc: { totalOrders: -1 } });
    }

    // Registrar en RejectedOrder con motivo 'cliente_cancelo'
    try {
      const RejectedOrder = require('../models/RejectedOrder');
      await new RejectedOrder({
        orderNumber: order.orderNumber,
        publicCode:  order.publicCode,
        client: { name: order.client?.name, whatsapp: order.client?.whatsapp, phone: order.client?.phone },
        items: order.items.map(i => ({ productName: i.productName, variant: i.variant, quantity: i.quantity })),
        total:  order.total,
        reason: 'cliente_cancelo',
        notes:  'Cancelado por el cliente desde el formulario público.',
      }).save();
    } catch (e) { console.error('Error guardando rechazo (cancel cliente):', e.message); }

    // WhatsApp de confirmación de cancelación al cliente (sin cupón — no es error nuestro)
    if (order.client?.whatsapp) {
      const { sendOrderCancelled } = require('../services/whatsapp');
      sendOrderCancelled(
        order.client.whatsapp,
        order.client.name || 'Cliente',
        order.publicCode,
        order.orderNumber
      ).catch(err => console.error('Error WA cancel cliente:', err.message));
    }

    // Notificar a la cocina via socket
    const io = req.app.get('io');
    if (io) io.to(`order_${order.orderNumber}`).emit('order_status', { status: 'cancelled', order });

    return res.json({ ok: true, cancelled: true });
  } catch (err) {
    console.error('Error cancelando pedido (cliente):', err.message);
    res.status(500).json({ message: 'Error al cancelar el pedido.' });
  }
});

module.exports = router;