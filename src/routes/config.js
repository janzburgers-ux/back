const express = require('express');
const router = express.Router();
const Config = require('../models/Config');
const { Product } = require('../models/Product');
const { auth, adminOnly } = require('../middleware/auth');

const DEFAULTS = {
  indirectCosts: { luz: 5, gas: 3, packaging: 4, otros: 3 },
  desiredMargin: 300,
  transferAlias: '',
  notesPlaceholder: 'Aclaraciones, alergias...',
  schedule: { days: [5, 6, 0], openHour: 19, closeHour: 23 },
  zones: [{ id: 'default', name: 'Barrio La Rotonda', cost: 0, freeFrom: 0 }],
  loyalty: {
    enabled: false, pointsPerPeso: 1, redeemThreshold: 500, couponPercent: 10,
    referralEnabled: false, referralRewardPercent: 5, referralDiscountForNew: 10
  },
  // Gastos fijos mensuales en $ reales
  fixedExpenses: {
    luz: 0, gas: 0, agua: 0, alquiler: 0, otros: 0
  },
  // Cupón por franja horaria
  hourlyDiscount: {
    enabled: false,
    discountPercent: 10,
    fromHour: '18:00',
    toHour: '20:00',
    couponCode: 'TEMPRANO'
  },
  // Parámetros de distribución
  costingParams: {
    avgBurgersPerDay: 30,
    deliveryCostPerShift: 0,
  },  // ← agregar coma
  // Límites de pedidos
  orderLimits: {
    enabled: false,
    dailyMax: 50
  },
  // Objetivos de Caja Global
  cajaGoals: {
    dia:   { money: 0, burgers: 0, orders: 0, newClients: 0, returningClients: 0, avgTicket: 0, coupons: 0 },
    finde: { money: 0, burgers: 0, orders: 0, newClients: 0, returningClients: 0, avgTicket: 0, coupons: 0 },
    mes:   { money: 0, burgers: 0, orders: 0, newClients: 0, returningClients: 0, avgTicket: 0, coupons: 0 },
    año:   { money: 0, burgers: 0, orders: 0, newClients: 0, returningClients: 0, avgTicket: 0, coupons: 0 }
  },
  // Configuración del sistema de reseñas
  reviewSettings: {
    enabled:          true,
    incentiveType:    'discount',   // 'discount' | 'product' | 'none'
    discountPercent:  10,
    productId:        null,
    productName:      'Papas fritas',
    validDays:        30,
    waitMinutes:      10,
    messageText:      ''
  },
  // Hamburguesa del día (promo con countdown)
  dailyDeal: {
    enabled:         false,
    name:            '',
    description:     '',
    originalPrice:   0,
    discountPrice:   0,
    discountPercent: 0,
    fromHour:        '19:00',
    toHour:          '21:00',
    image:           '',
    productId:       null
  },
  // Hamburguesa del mes
  monthlyBurger: {
    enabled:     false,
    name:        '',
    description: '',
    price:       0,
    image:       '',
    badge:       '🏆 Del mes',
    month:       ''
  }
};

async function upsert(key, value, label = '') {
  // $set + overwrite completo para evitar que Mongoose ignore cambios en campos Mixed
  return Config.findOneAndUpdate(
    { key },
    { $set: { key, value, label } },
    { upsert: true, new: true, overwrite: false }
  );
}

async function getConfig() {
  const configs = await Config.find();
  const result = { ...DEFAULTS };
  configs.forEach(c => { result[c.key] = c.value; });
  return result;
}

// ── Calcular cuántos días operativos hay en un mes dado ───────────────────
function countOperationalDays(schedule, year, month) {
  const days = schedule?.days || [5, 6, 0];
  let count = 0;
  const d = new Date(year, month - 1, 1);
  while (d.getMonth() === month - 1) {
    if (days.includes(d.getDay())) count++;
    d.setDate(d.getDate() + 1);
  }
  return count;
}

// ── Calcular costo fijo por burger dado gastos del mes ────────────────────
function calcFixedCostPerBurger(fixedExpenses, costingParams, schedule) {
  const now = new Date();
  const operationalDays = countOperationalDays(schedule, now.getFullYear(), now.getMonth() + 1);
  if (!operationalDays) return 0;

  const totalFixed = Object.values(fixedExpenses || {}).reduce((s, v) => s + Number(v || 0), 0);
  const costPerDay = totalFixed / operationalDays;
  const avgBurgers = Number(costingParams?.avgBurgersPerDay) || 30;
  return Math.round(costPerDay / avgBurgers);
}

function calcDeliveryCostPerBurger(costingParams) {
  const perShift = Number(costingParams?.deliveryCostPerShift) || 0;
  const avgBurgers = Number(costingParams?.avgBurgersPerDay) || 30;
  if (!perShift || !avgBurgers) return 0;
  return Math.round(perShift / avgBurgers);
}

// ── GET toda la config (admin) ─────────────────────────────────────────────
router.get('/', auth, adminOnly, async (req, res) => {
  try {
    const result = await getConfig();
    console.log('📤 SCHEDULE LEÍDO:', JSON.stringify(result.schedule)); // ← ESTO

    // Calcular días operativos del mes actual
    const now = new Date();
    result.operationalDaysThisMonth = countOperationalDays(result.schedule, now.getFullYear(), now.getMonth() + 1);
    result.fixedCostPerBurger = calcFixedCostPerBurger(result.fixedExpenses, result.costingParams, result.schedule);
    result.deliveryCostPerBurger = calcDeliveryCostPerBurger(result.costingParams);

    res.json(result);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── GET config pública ─────────────────────────────────────────────────────
router.get('/public', async (req, res) => {
  try {
    const keys = ['schedule', 'zones', 'transferAlias', 'loyalty', 'hourlyDiscount', 'notesPlaceholder', 'max-orders-per-slot'];
    // Normalizar la key con guiones a camelCase para el frontend
    const keyMap = { 'max-orders-per-slot': 'maxOrdersPerSlot' };
    const configs = await Config.find({ key: { $in: keys } });
    const result = {};
    keys.forEach(k => { const mapped = keyMap[k] || k; result[mapped] = DEFAULTS[k] !== undefined ? DEFAULTS[k] : null; });
    configs.forEach(cfg => { const k = keyMap[cfg.key] || cfg.key; result[k] = cfg.value; });
    res.json(result);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── PUT alias ─────────────────────────────────────────────────────────────
router.put('/transfer-alias', auth, adminOnly, async (req, res) => {
  try {
    await upsert('transferAlias', req.body.transferAlias, 'Alias de transferencia');
    res.json({ message: 'Alias actualizado' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── PUT horario ───────────────────────────────────────────────────────────
router.put('/schedule', auth, adminOnly, async (req, res) => {
  try {
    const raw = req.body.schedule;
    console.log('📥 SCHEDULE RECIBIDO:', JSON.stringify(raw));
    // Compatibilidad: aceptar tanto número como string "HH:MM"
    const toTimeStr = v => {
      if (typeof v === 'string' && v.includes(':')) return v;
      return `${String(Number(v) || 0).padStart(2,'0')}:00`;
    };
    const schedule = {
      days: (raw.days || []).map(Number),
      openHour: toTimeStr(raw.openHour),
      closeHour: toTimeStr(raw.closeHour),
    };
    console.log('💾 SCHEDULE A GUARDAR:', JSON.stringify(schedule));
    await upsert('schedule', schedule, 'Horario de atención');
    res.json({ message: 'Horario actualizado', schedule });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── Zonas ─────────────────────────────────────────────────────────────────
router.get('/zones', auth, async (req, res) => {
  try {
    const cfg = await Config.findOne({ key: 'zones' });
    res.json(cfg?.value || DEFAULTS.zones);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.post('/zones', auth, adminOnly, async (req, res) => {
  try {
    const cfg = await Config.findOne({ key: 'zones' });
    const zones = cfg?.value || [];
    const newZone = { id: Date.now().toString(), name: req.body.name, cost: Number(req.body.cost) || 0, freeFrom: Number(req.body.freeFrom) || 0 };
    zones.push(newZone);
    await upsert('zones', zones, 'Zonas de delivery');
    res.json(newZone);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.put('/zones/:id', auth, adminOnly, async (req, res) => {
  try {
    const cfg = await Config.findOne({ key: 'zones' });
    let zones = cfg?.value || [];
    zones = zones.map(z => z.id === req.params.id ? { ...z, ...req.body, id: z.id } : z);
    await upsert('zones', zones, 'Zonas de delivery');
    res.json({ message: 'Zona actualizada' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.delete('/zones/:id', auth, adminOnly, async (req, res) => {
  try {
    const cfg = await Config.findOne({ key: 'zones' });
    const zones = (cfg?.value || []).filter(z => z.id !== req.params.id);
    await upsert('zones', zones, 'Zonas de delivery');
    res.json({ message: 'Zona eliminada' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── PUT costos indirectos y margen (compatibilidad) ───────────────────────
router.put('/costing', auth, adminOnly, async (req, res) => {
  try {
    const { indirectCosts, desiredMargin } = req.body;
    if (indirectCosts !== undefined) await upsert('indirectCosts', indirectCosts, 'Costos indirectos (%)');
    if (desiredMargin !== undefined) await upsert('desiredMargin', Number(desiredMargin), 'Margen deseado (%)');
    await recalcAllProducts();
    res.json({ message: 'Costos actualizados y productos recalculados' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── PUT gastos fijos mensuales ────────────────────────────────────────────
router.put('/fixed-expenses', auth, adminOnly, async (req, res) => {
  try {
    await upsert('fixedExpenses', req.body.fixedExpenses, 'Gastos fijos mensuales');
    await recalcAllProducts();
    res.json({ message: 'Gastos fijos guardados y escandallo recalculado' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── PUT parámetros de distribución (burgers/día, delivery/jornada) ────────
router.put('/costing-params', auth, adminOnly, async (req, res) => {
  try {
    await upsert('costingParams', req.body.costingParams, 'Parámetros de distribución de costos');
    await recalcAllProducts();
    res.json({ message: 'Parámetros guardados y escandallo recalculado' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── PUT fidelización ──────────────────────────────────────────────────────
router.put('/loyalty', auth, adminOnly, async (req, res) => {
  try {
    await upsert('loyalty', req.body.loyalty, 'Sistema de fidelización');
    res.json({ message: 'Fidelización actualizada' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── PUT general (compatibilidad) ──────────────────────────────────────────
router.put('/', auth, adminOnly, async (req, res) => {
  try {
    const { indirectCosts, desiredMargin } = req.body;
    if (indirectCosts !== undefined) await upsert('indirectCosts', indirectCosts, 'Costos indirectos (%)');
    if (desiredMargin !== undefined) await upsert('desiredMargin', Number(desiredMargin), 'Margen deseado (%)');
    await recalcAllProducts();
    res.json({ message: 'Configuración actualizada' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── Recalcular todos los productos con desglose completo ──────────────────
async function recalcAllProducts() {
  const cfg = await getConfig();
  const { indirectCosts, desiredMargin, fixedExpenses, costingParams, schedule } = cfg;

  const totalIndirectPct = Object.values(indirectCosts || {}).reduce((s, v) => s + Number(v), 0);
  const fixedCostPerBurger = calcFixedCostPerBurger(fixedExpenses, costingParams, schedule);
  const deliveryCostPerBurger = calcDeliveryCostPerBurger(costingParams);

  const products = await Product.find({ active: true }).populate({
    path: 'recipe',
    populate: { path: 'ingredients.ingredient' }
  });

  for (const product of products) {
    if (!product.recipe) continue;

    // 🥩 1. Costo de ingredientes
    let ingredientCost = 0;
    for (const ri of product.recipe.ingredients) {
      if (ri.ingredient) ingredientCost += (ri.ingredient.costPerUnit || 0) * ri.quantity;
    }
    ingredientCost = Math.round(ingredientCost);

    // 💡 2. Costos indirectos (% sobre ingredientes — luz, gas como %)
    const indirectCost = Math.round(ingredientCost * totalIndirectPct / 100);

    // 📦 3. Packaging por unidad (1 papel aluminio + proporción de bolsa + bandejita)
    // Aproximación: 1 papel + 0.33 bolsas + 1 bandejita por burger
    const packagingCostPerUnit = 0; // se calcula dinámicamente en cash register; aquí 0 como base

    // 🏠 4. Gastos fijos distribuidos por burger
    const fixedPerUnit = fixedCostPerBurger;

    // 🛵 5. Delivery distribuido por burger
    const deliveryPerUnit = deliveryCostPerBurger;

    // 💰 Costo total con ingredientes + indirectos (como antes)
    const totalCost = Math.round(ingredientCost + indirectCost);

    // 💰 Costo real incluyendo fijos y delivery
    const realTotalCost = Math.round(totalCost + fixedPerUnit + deliveryPerUnit);

    const profit = product.salePrice - realTotalCost;
    const margin = product.salePrice > 0 ? Math.round((profit / product.salePrice) * 100) : 0;
    const suggestedPrice = Math.round(realTotalCost * (1 + Number(desiredMargin) / 100));

    await Product.findByIdAndUpdate(product._id, {
      totalCost,
      ingredientCost,
      indirectCost,
      fixedCostPerUnit: fixedPerUnit,
      deliveryCostPerUnit: deliveryPerUnit,
      packagingCostPerUnit,
      realTotalCost,
      profit,
      margin,
      suggestedPrice
    });
  }
}

module.exports = router;
module.exports.recalcAllProducts = recalcAllProducts;

// PUT genérico para cualquier clave de config
router.put('/:key', auth, adminOnly, async (req, res) => {
  try {
    const { key } = req.params;
    const { value } = req.body;
    await upsert(key, value);
    res.json({ key, value });
  } catch (err) { res.status(500).json({ message: err.message }); }
});