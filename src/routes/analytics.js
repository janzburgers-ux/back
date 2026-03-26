const express = require('express');
const router = express.Router();
const { Order, Client } = require('../models/Order');
const { auth, adminOnly } = require('../middleware/auth');

// ── Helpers ───────────────────────────────────────────────────────────────────
function scoreRFM(value, thresholds) {
  // thresholds: [p20, p40, p60, p80] => score 1-5
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

    // Clients with at least 1 order
    const clients = await Client.find({ active: true, totalOrders: { $gt: 0 } });
    if (clients.length === 0) return res.json({ segments: [], clients: [], summary: {} });

    // Last order date per client
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
      return {
        _id: c._id,
        name: c.name,
        phone: c.phone,
        whatsapp: c.whatsapp,
        recencyDays,
        frequency: ord.count,
        monetary: ord.total,
        loyaltyPoints: c.loyaltyPoints
      };
    }).filter(Boolean);

    if (rfmData.length === 0) return res.json({ segments: [], clients: [], summary: {} });

    // Compute percentiles for scoring
    const recencies = rfmData.map(r => r.recencyDays);
    const freqs = rfmData.map(r => r.frequency);
    const moneys = rfmData.map(r => r.monetary);

    const rThresh = [percentile(recencies, 20), percentile(recencies, 40), percentile(recencies, 60), percentile(recencies, 80)];
    const fThresh = [percentile(freqs, 20), percentile(freqs, 40), percentile(freqs, 60), percentile(freqs, 80)];
    const mThresh = [percentile(moneys, 20), percentile(moneys, 40), percentile(moneys, 60), percentile(moneys, 80)];

    const scored = rfmData.map(c => {
      const rScore = scoreRFM(c.recencyDays, rThresh);
      const fScore = scoreFreqMonetary(c.frequency, fThresh);
      const mScore = scoreFreqMonetary(c.monetary, mThresh);
      const segment = getRFMSegment(rScore, fScore, mScore);
      return { ...c, rScore, fScore, mScore, totalScore: rScore + fScore + mScore, segment };
    });

    // Summary by segment
    const segmentMap = {};
    scored.forEach(c => {
      const key = c.segment.label;
      if (!segmentMap[key]) segmentMap[key] = { label: key, color: c.segment.color, emoji: c.segment.emoji, count: 0, revenue: 0 };
      segmentMap[key].count++;
      segmentMap[key].revenue += c.monetary;
    });

    res.json({
      clients: scored.sort((a, b) => b.totalScore - a.totalScore),
      segments: Object.values(segmentMap).sort((a, b) => b.revenue - a.revenue),
      total: scored.length
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── 2. Churn Detection ────────────────────────────────────────────────────
router.get('/churn', auth, adminOnly, async (req, res) => {
  try {
    const now = new Date();
    const CHURN_DAYS = 21; // days without order = at risk

    const atRisk = await Order.aggregate([
      { $match: { status: { $ne: 'cancelled' } } },
      { $group: { _id: '$client', lastOrder: { $max: '$createdAt' }, totalOrders: { $sum: 1 }, totalSpent: { $sum: '$total' } } },
      {
        $addFields: {
          daysSince: { $divide: [{ $subtract: [now, '$lastOrder'] }, 1000 * 60 * 60 * 24] }
        }
      },
      { $match: { daysSince: { $gte: CHURN_DAYS }, totalOrders: { $gte: 2 } } },
      { $sort: { totalSpent: -1 } },
      { $limit: 30 }
    ]);

    // Populate client names
    const clientIds = atRisk.map(r => r._id);
    const clients = await Client.find({ _id: { $in: clientIds }, active: true }).select('name phone whatsapp');
    const clientMap = {};
    clients.forEach(c => { clientMap[c._id.toString()] = c; });

    const result = atRisk
      .map(r => {
        const client = clientMap[r._id.toString()];
        if (!client) return null;
        const days = Math.round(r.daysSince);
        const riskLevel = days > 45 ? 'alto' : days > 30 ? 'medio' : 'bajo';
        return {
          clientId: r._id,
          name: client.name,
          phone: client.phone,
          whatsapp: client.whatsapp,
          daysSinceLastOrder: days,
          totalOrders: r.totalOrders,
          totalSpent: r.totalSpent,
          lastOrder: r.lastOrder,
          riskLevel
        };
      })
      .filter(Boolean);

    res.json({
      atRisk: result,
      summary: {
        total: result.length,
        high: result.filter(r => r.riskLevel === 'alto').length,
        medium: result.filter(r => r.riskLevel === 'medio').length,
        low: result.filter(r => r.riskLevel === 'bajo').length,
        totalRevenueAtRisk: result.reduce((s, r) => s + r.totalSpent, 0)
      }
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── 3. Demand Prediction ───────────────────────────────────────────────────
router.get('/demand', auth, adminOnly, async (req, res) => {
  try {
    const days = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

    // Últimas 8 semanas de pedidos
    const since = new Date();
    since.setDate(since.getDate() - 56);

    const orders = await Order.find({
      createdAt: { $gte: since },
      status: { $ne: 'cancelled' }
    }).populate('items.product', 'name variant');

    // Agrupar por día de semana
    const byDow = {};
    for (let i = 0; i < 7; i++) byDow[i] = { orders: [], revenue: [], items: {} };

    orders.forEach(order => {
      const dow = new Date(order.createdAt).getDay();
      byDow[dow].orders.push(order.items.reduce((s, i) => s + i.quantity, 0));
      byDow[dow].revenue.push(order.total);
      order.items.forEach(item => {
        const key = `${item.productName || 'Producto'} ${item.variant || ''}`.trim();
        byDow[dow].items[key] = (byDow[dow].items[key] || 0) + item.quantity;
      });
    });

    // Calcular promedios ponderados (semanas recientes pesan más)
    const forecast = days.map((name, dow) => {
      const data = byDow[dow];
      const avg = arr => arr.length > 0 ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
      const topItems = Object.entries(data.items)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([name, qty]) => ({ name, qty: Math.round(qty / Math.max(1, data.orders.length / 7)) }));

      return {
        day: name,
        dow,
        avgOrders: Math.round(avg(data.orders) * 7 / Math.max(data.orders.length, 1) * data.orders.length / 7) || 0,
        avgRevenue: Math.round(avg(data.revenue)),
        dataPoints: data.orders.length,
        topItems
      };
    });

    // Next 7 days prediction
    const today = new Date().getDay();
    const next7 = Array.from({ length: 7 }, (_, i) => {
      const dow = (today + i) % 7;
      const d = new Date();
      d.setDate(d.getDate() + i);
      return {
        ...forecast[dow],
        date: d.toLocaleDateString('es-AR', { weekday: 'short', day: 'numeric', month: 'short' }),
        isToday: i === 0
      };
    });

    res.json({ byDow: forecast, next7, weeksAnalyzed: 8 });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── 4. Cross-sell (product pair analysis) ─────────────────────────────────
router.get('/crosssell', auth, adminOnly, async (req, res) => {
  try {
    const orders = await Order.find({ status: { $ne: 'cancelled' } }).select('items');

    const pairCounts = {};
    const itemCounts = {};

    orders.forEach(order => {
      const products = order.items.map(i => `${i.productName || '?'} ${i.variant || ''}`.trim());
      const unique = [...new Set(products)];

      unique.forEach(p => { itemCounts[p] = (itemCounts[p] || 0) + 1; });

      for (let i = 0; i < unique.length; i++) {
        for (let j = i + 1; j < unique.length; j++) {
          const pair = [unique[i], unique[j]].sort().join(' + ');
          pairCounts[pair] = (pairCounts[pair] || 0) + 1;
        }
      }
    });

    const totalOrders = orders.length;
    const pairs = Object.entries(pairCounts)
      .filter(([, count]) => count >= 2)
      .map(([pair, count]) => {
        const [a, b] = pair.split(' + ');
        const support = count / totalOrders;
        const confAB = itemCounts[a] > 0 ? count / itemCounts[a] : 0;
        const confBA = itemCounts[b] > 0 ? count / itemCounts[b] : 0;
        return { pair, a, b, count, support: Math.round(support * 100), confidence: Math.round(Math.max(confAB, confBA) * 100) };
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, 15);

    // Top individual products
    const topProducts = Object.entries(itemCounts)
      .map(([name, count]) => ({ name, count, share: Math.round(count / totalOrders * 100) }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    res.json({ pairs, topProducts, totalOrdersAnalyzed: totalOrders });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── 5. Hourly Profitability ────────────────────────────────────────────────
router.get('/hourly', auth, adminOnly, async (req, res) => {
  try {
    const since = new Date();
    since.setDate(since.getDate() - 30);

    const orders = await Order.find({
      createdAt: { $gte: since },
      status: { $ne: 'cancelled' }
    });

    const hourly = {};
    for (let h = 0; h < 24; h++) hourly[h] = { hour: h, orders: 0, revenue: 0 };

    orders.forEach(o => {
      const h = new Date(o.createdAt).getHours();
      hourly[h].orders++;
      hourly[h].revenue += o.total;
    });

    const result = Object.values(hourly)
      .filter(h => h.orders > 0)
      .map(h => ({
        ...h,
        label: `${String(h.hour).padStart(2, '0')}:00`,
        avgTicket: h.orders > 0 ? Math.round(h.revenue / h.orders) : 0
      }));

    const peakHour = result.reduce((max, h) => h.revenue > (max?.revenue || 0) ? h : max, null);

    res.json({ hourly: result, peakHour, daysAnalyzed: 30 });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── 6. Smart Alerts ────────────────────────────────────────────────────────
router.get('/alerts', auth, adminOnly, async (req, res) => {
  try {
    const alerts = [];
    const now = new Date();

    // Check churn
    const churnCount = await Order.aggregate([
      { $match: { status: { $ne: 'cancelled' } } },
      { $group: { _id: '$client', lastOrder: { $max: '$createdAt' }, totalOrders: { $sum: 1 } } },
      { $addFields: { daysSince: { $divide: [{ $subtract: [now, '$lastOrder'] }, 86400000] } } },
      { $match: { daysSince: { $gte: 21 }, totalOrders: { $gte: 2 } } },
      { $count: 'total' }
    ]);
    if (churnCount[0]?.total > 0) {
      alerts.push({ type: 'churn', level: 'warning', message: `${churnCount[0].total} clientes sin pedir hace +21 días`, action: '/analytics' });
    }

    // Check revenue trend (this week vs last week)
    const weekStart = new Date(); weekStart.setDate(weekStart.getDate() - 7); weekStart.setHours(0, 0, 0, 0);
    const prevWeekStart = new Date(); prevWeekStart.setDate(prevWeekStart.getDate() - 14); prevWeekStart.setHours(0, 0, 0, 0);

    const [thisWeek, lastWeek] = await Promise.all([
      Order.aggregate([{ $match: { createdAt: { $gte: weekStart }, status: { $ne: 'cancelled' } } }, { $group: { _id: null, total: { $sum: '$total' } } }]),
      Order.aggregate([{ $match: { createdAt: { $gte: prevWeekStart, $lt: weekStart }, status: { $ne: 'cancelled' } } }, { $group: { _id: null, total: { $sum: '$total' } } }])
    ]);

    const tw = thisWeek[0]?.total || 0;
    const lw = lastWeek[0]?.total || 1;
    const trend = Math.round(((tw - lw) / lw) * 100);

    if (trend < -20) {
      alerts.push({ type: 'revenue', level: 'danger', message: `Ingresos esta semana bajaron ${Math.abs(trend)}% vs semana anterior`, action: '/' });
    } else if (trend > 20) {
      alerts.push({ type: 'revenue', level: 'success', message: `Ingresos esta semana subieron ${trend}% vs semana anterior`, action: '/' });
    }

    res.json({ alerts, weekTrend: trend });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

module.exports = router;
