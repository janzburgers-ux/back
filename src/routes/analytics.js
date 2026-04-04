const express = require('express');
const router = express.Router();
const { Order, Client } = require('../models/Order');
const { auth, adminOnly } = require('../middleware/auth');

function scoreRFM(value, thresholds) {
  if (value <= thresholds[0]) return 5;
  if (value <= thresholds[1]) return 4;
  if (value <= thresholds[2]) return 3;
  if (value <= thresholds[3]) return 2;
  return 1;
}
function scoreFreqMonetary(value, thresholds) {
  if (value >= thresholds[3]) return 5;
  if (value >= thresholds[2]) return 4;
  if (value >= thresholds[1]) return 3;
  if (value >= thresholds[0]) return 2;
  return 1;
}
function percentile(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.floor((p / 100) * sorted.length);
  return sorted[Math.min(idx, sorted.length - 1)];
}
function getRFMSegment(r, f, m) {
  const score = r + f + m;
  if (r >= 4 && f >= 4 && m >= 4) return { label: 'VIP', color: '#E8B84B', emoji: '👑' };
  if (r >= 3 && f >= 3) return { label: 'Leal', color: '#22c55e', emoji: '⭐' };
  if (r >= 4 && f <= 2) return { label: 'Nuevo prometedor', color: '#818cf8', emoji: '🆕' };
  if (r <= 2 && f >= 3 && m >= 3) return { label: 'En riesgo', color: '#f59e0b', emoji: '⚠️' };
  if (r <= 1 && f >= 3) return { label: 'Perdido', color: '#ef4444', emoji: '💤' };
  if (r >= 3 && score >= 9) return { label: 'Potencial', color: '#06b6d4', emoji: '📈' };
  return { label: 'Ocasional', color: '#888', emoji: '🔄' };
}

// ── 1. RFM Segmentation ────────────────────────────────────────────────────
router.get('/rfm', auth, adminOnly, async (req, res) => {
  try {
    const now = new Date();
    const clients = await Client.find({ active: true, totalOrders: { $gt: 0 } });
    if (clients.length === 0) return res.json({ segments: [], clients: [], summary: {} });
    const lastOrders = await Order.aggregate([
      { $match: { status: { $ne: 'cancelled' } } },
      { $group: { _id: '$client', lastDate: { $max: '$createdAt' }, count: { $sum: 1 }, total: { $sum: '$total' } } }
    ]);
    const orderMap = {};
    lastOrders.forEach(o => { orderMap[o._id.toString()] = o; });
    const rfmData = clients.map(c => {
      const ord = orderMap[c._id.toString()];
      if (!ord) return null;
      const recencyDays = Math.round((now - new Date(ord.lastDate)) / (1000 * 60 * 60 * 24));
      return { _id: c._id, name: c.name, phone: c.phone, whatsapp: c.whatsapp, recencyDays, frequency: ord.count, monetary: ord.total, loyaltyPoints: c.loyaltyPoints };
    }).filter(Boolean);
    if (rfmData.length === 0) return res.json({ segments: [], clients: [], summary: {} });
    const recencies = rfmData.map(r => r.recencyDays);
    const freqs = rfmData.map(r => r.frequency);
    const moneys = rfmData.map(r => r.monetary);
    const rThresholds = [percentile(recencies, 20), percentile(recencies, 40), percentile(recencies, 60), percentile(recencies, 80)];
    const fThresholds = [percentile(freqs, 20), percentile(freqs, 40), percentile(freqs, 60), percentile(freqs, 80)];
    const mThresholds = [percentile(moneys, 20), percentile(moneys, 40), percentile(moneys, 60), percentile(moneys, 80)];
    const scored = rfmData.map(c => {
      const r = scoreRFM(c.recencyDays, rThresholds);
      const f = scoreFreqMonetary(c.frequency, fThresholds);
      const m = scoreFreqMonetary(c.monetary, mThresholds);
      const segment = getRFMSegment(r, f, m);
      return { ...c, r, f, m, rfmScore: r + f + m, segment };
    });
    const segmentCounts = {};
    scored.forEach(c => {
      const key = c.segment.label;
      segmentCounts[key] = (segmentCounts[key] || { label: key, color: c.segment.color, emoji: c.segment.emoji, count: 0, revenue: 0 });
      segmentCounts[key].count++;
      segmentCounts[key].revenue += c.monetary || 0;
    });
    res.json({ clients: scored.sort((a, b) => b.rfmScore - a.rfmScore), segments: Object.values(segmentCounts).sort((a, b) => b.count - a.count), summary: { total: scored.length, avgRecency: Math.round(recencies.reduce((s, v) => s + v, 0) / recencies.length), avgFrequency: Math.round(freqs.reduce((s, v) => s + v, 0) / freqs.length * 10) / 10, avgMonetary: Math.round(moneys.reduce((s, v) => s + v, 0) / moneys.length) } });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── 2. Churn Detection ─────────────────────────────────────────────────────
router.get('/churn', auth, adminOnly, async (req, res) => {
  try {
    const now = new Date();
    const lastOrders = await Order.aggregate([
      { $match: { status: { $ne: 'cancelled' } } },
      { $group: { _id: '$client', lastOrder: { $max: '$createdAt' }, totalOrders: { $sum: 1 }, totalSpent: { $sum: '$total' } } }
    ]);
    const clientIds = lastOrders.map(o => o._id);
    const clients = await Client.find({ _id: { $in: clientIds }, active: true });
    const clientMap = {};
    clients.forEach(c => { clientMap[c._id.toString()] = c; });

    const atRisk = lastOrders.map(o => {
      const c = clientMap[o._id.toString()];
      if (!c) return null;
      const daysSinceLastOrder = Math.round((now - new Date(o.lastOrder)) / (1000 * 60 * 60 * 24));
      // alto: +45d | medio: 30-45d | bajo: 21-30d
      const riskLevel = daysSinceLastOrder >= 45 ? 'alto'
                      : daysSinceLastOrder >= 30 ? 'medio'
                      : daysSinceLastOrder >= 21 ? 'bajo'
                      : null;
      if (!riskLevel || o.totalOrders < 2) return null;
      return {
        clientId: c._id,
        name: c.name,
        whatsapp: c.whatsapp,
        lastOrder: o.lastOrder,
        daysSinceLastOrder,
        totalOrders: o.totalOrders,
        totalSpent: o.totalSpent,
        riskLevel
      };
    }).filter(Boolean).sort((a, b) => b.daysSinceLastOrder - a.daysSinceLastOrder);

    const totalRevenueAtRisk = atRisk.reduce((s, c) => s + (c.totalSpent || 0), 0);

    res.json({
      atRisk,
      summary: {
        total: atRisk.length,
        high:   atRisk.filter(c => c.riskLevel === 'alto').length,
        medium: atRisk.filter(c => c.riskLevel === 'medio').length,
        low:    atRisk.filter(c => c.riskLevel === 'bajo').length,
        totalRevenueAtRisk
      }
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── 3. Demand Forecast ─────────────────────────────────────────────────────
router.get('/forecast', auth, adminOnly, async (req, res) => {
  try {
    const since = new Date(); since.setDate(since.getDate() - 56);
    const orders = await Order.find({ createdAt: { $gte: since }, status: { $ne: 'cancelled' } });
    const days = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
    const byDow = {};
    days.forEach((d, i) => { byDow[i] = { name: d, orders: [], revenue: [], items: {} }; });
    orders.forEach(o => {
      const dow = new Date(o.createdAt).getDay();
      byDow[dow].orders.push(o.total);
      byDow[dow].revenue.push(o.total);
      o.items.forEach(item => {
        const key = `${item.productName} ${item.variant}`.trim();
        byDow[dow].items[key] = (byDow[dow].items[key] || 0) + item.quantity;
      });
    });
    const forecast = days.map((name, dow) => {
      const data = byDow[dow];
      const avg = arr => arr.length > 0 ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
      const topItems = Object.entries(data.items).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name, qty]) => ({ name, qty: Math.round(qty / Math.max(1, data.orders.length / 7)) }));
      return { day: name, dow, avgOrders: Math.round(avg(data.orders) * 7 / Math.max(data.orders.length, 1) * data.orders.length / 7) || 0, avgRevenue: Math.round(avg(data.revenue)), dataPoints: data.orders.length, topItems };
    });
    const today = new Date().getDay();
    const next7 = Array.from({ length: 7 }, (_, i) => {
      const dow = (today + i) % 7;
      const d = new Date(); d.setDate(d.getDate() + i);
      return { ...forecast[dow], date: d.toLocaleDateString('es-AR', { weekday: 'short', day: 'numeric', month: 'short' }), isToday: i === 0 };
    });
    res.json({ byDow: forecast, next7, weeksAnalyzed: 8 });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── 4. Cross-sell ──────────────────────────────────────────────────────────
router.get('/crosssell', auth, adminOnly, async (req, res) => {
  try {
    const orders = await Order.find({ status: { $ne: 'cancelled' } }).select('items');
    const pairCounts = {}; const itemCounts = {};
    orders.forEach(order => {
      const products = order.items.map(i => `${i.productName || '?'} ${i.variant || ''}`.trim());
      const unique = [...new Set(products)];
      unique.forEach(p => { itemCounts[p] = (itemCounts[p] || 0) + 1; });
      for (let i = 0; i < unique.length; i++)
        for (let j = i + 1; j < unique.length; j++) {
          const pair = [unique[i], unique[j]].sort().join(' + ');
          pairCounts[pair] = (pairCounts[pair] || 0) + 1;
        }
    });
    const totalOrders = orders.length;
    const pairs = Object.entries(pairCounts).filter(([, count]) => count >= 2).map(([pair, count]) => {
      const [a, b] = pair.split(' + ');
      const confAB = itemCounts[a] > 0 ? count / itemCounts[a] : 0;
      const confBA = itemCounts[b] > 0 ? count / itemCounts[b] : 0;
      return { pair, a, b, count, support: Math.round(count / totalOrders * 100), confidence: Math.round(Math.max(confAB, confBA) * 100) };
    }).sort((a, b) => b.count - a.count).slice(0, 15);
    const topProducts = Object.entries(itemCounts).map(([name, count]) => ({ name, count, share: Math.round(count / totalOrders * 100) })).sort((a, b) => b.count - a.count).slice(0, 10);
    res.json({ pairs, topProducts, totalOrdersAnalyzed: totalOrders });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── 5. Hourly Profitability ────────────────────────────────────────────────
router.get('/hourly', auth, adminOnly, async (req, res) => {
  try {
    const since = new Date(); since.setDate(since.getDate() - 30);
    const orders = await Order.find({ createdAt: { $gte: since }, status: { $ne: 'cancelled' } });
    const hourly = {};
    for (let h = 0; h < 24; h++) hourly[h] = { hour: h, orders: 0, revenue: 0 };
    orders.forEach(o => { const h = new Date(o.createdAt).getHours(); hourly[h].orders++; hourly[h].revenue += o.total; });
    const result = Object.values(hourly).filter(h => h.orders > 0).map(h => ({ ...h, label: `${String(h.hour).padStart(2, '0')}:00`, avgTicket: h.orders > 0 ? Math.round(h.revenue / h.orders) : 0 }));
    const peakHour = result.reduce((max, h) => h.revenue > (max?.revenue || 0) ? h : max, null);
    res.json({ hourly: result, peakHour, daysAnalyzed: 30 });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── 6. Smart Alerts ────────────────────────────────────────────────────────
router.get('/alerts', auth, adminOnly, async (req, res) => {
  try {
    const alerts = []; const now = new Date();
    const churnCount = await Order.aggregate([
      { $match: { status: { $ne: 'cancelled' } } },
      { $group: { _id: '$client', lastOrder: { $max: '$createdAt' }, totalOrders: { $sum: 1 } } },
      { $addFields: { daysSince: { $divide: [{ $subtract: [now, '$lastOrder'] }, 86400000] } } },
      { $match: { daysSince: { $gte: 21 }, totalOrders: { $gte: 2 } } },
      { $count: 'total' }
    ]);
    if (churnCount[0]?.total > 0) alerts.push({ type: 'churn', level: 'warning', message: `${churnCount[0].total} clientes sin pedir hace +21 días`, action: '/analytics' });
    const weekStart = new Date(); weekStart.setDate(weekStart.getDate() - 7); weekStart.setHours(0, 0, 0, 0);
    const prevWeekStart = new Date(); prevWeekStart.setDate(prevWeekStart.getDate() - 14); prevWeekStart.setHours(0, 0, 0, 0);
    const [thisWeek, lastWeek] = await Promise.all([
      Order.aggregate([{ $match: { createdAt: { $gte: weekStart }, status: { $ne: 'cancelled' } } }, { $group: { _id: null, total: { $sum: '$total' } } }]),
      Order.aggregate([{ $match: { createdAt: { $gte: prevWeekStart, $lt: weekStart }, status: { $ne: 'cancelled' } } }, { $group: { _id: null, total: { $sum: '$total' } } }])
    ]);
    const tw = thisWeek[0]?.total || 0; const lw = lastWeek[0]?.total || 1;
    const trend = Math.round(((tw - lw) / lw) * 100);
    if (trend < -20) alerts.push({ type: 'revenue', level: 'danger', message: `Ingresos esta semana bajaron ${Math.abs(trend)}% vs semana anterior`, action: '/' });
    else if (trend > 20) alerts.push({ type: 'revenue', level: 'success', message: `Ingresos esta semana subieron ${trend}% vs semana anterior`, action: '/' });
    res.json({ alerts, weekTrend: trend });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── 7. Ingredient Usage por mes ────────────────────────────────────────────
// Calcula cuánto se usó de cada ingrediente en un período dado
// basado en los pedidos entregados y las recetas de cada producto.
router.get('/ingredient-usage', auth, adminOnly, async (req, res) => {
  try {
    const { month, year } = req.query;
    const { Recipe, Product } = require('../models/Product');
    const Ingredient = require('../models/Ingredient');

    let start, end;
    if (month && year) {
      start = new Date(Number(year), Number(month) - 1, 1, 0, 0, 0);
      end   = new Date(Number(year), Number(month), 0, 23, 59, 59, 999);
    } else {
      const now = new Date();
      start = new Date(now.getFullYear(), now.getMonth(), 1);
      end   = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
    }

    // Traer pedidos entregados o confirmados del período
    const orders = await Order.find({
      createdAt: { $gte: start, $lte: end },
      status: { $in: ['delivered', 'confirmed', 'preparing', 'ready'] }
    }).select('items');

    // Acumular cantidad por producto
    const productQty = {};
    orders.forEach(order => {
      order.items.forEach(item => {
        const pid = item.product?.toString();
        if (!pid) return;
        productQty[pid] = (productQty[pid] || 0) + item.quantity;
      });
    });

    // Para cada producto, cargar su receta y acumular ingredientes
    const ingredientUsage = {}; // { ingredientId: { name, unit, totalQty, costPerUnit, totalCost } }

    for (const [productId, qty] of Object.entries(productQty)) {
      const product = await Product.findById(productId).populate({
        path: 'recipe',
        populate: { path: 'ingredients.ingredient' }
      });
      if (!product?.recipe) continue;

      for (const ri of product.recipe.ingredients) {
        const ing = ri.ingredient;
        if (!ing) continue;
        const ingId = ing._id.toString();
        if (!ingredientUsage[ingId]) {
          ingredientUsage[ingId] = {
            _id: ingId,
            name: ing.name,
            unit: ing.unit || 'u',
            totalQty: 0,
            costPerUnit: ing.costPerUnit || 0,
            totalCost: 0
          };
        }
        ingredientUsage[ingId].totalQty += ri.quantity * qty;
      }
    }

    // Calcular costo total y redondear
    const result = Object.values(ingredientUsage).map(ing => ({
      ...ing,
      totalQty: Math.round(ing.totalQty * 100) / 100,
      totalCost: Math.round(ing.totalQty * ing.costPerUnit)
    })).sort((a, b) => b.totalCost - a.totalCost);

    const totalIngredientCost = result.reduce((s, i) => s + i.totalCost, 0);

    res.json({
      ingredients: result,
      totalIngredientCost,
      period: { month: Number(month), year: Number(year), start, end },
      ordersAnalyzed: orders.length
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

module.exports = router;