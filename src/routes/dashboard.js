const express = require('express');
const router = express.Router();
const { Order, Client } = require('../models/Order');
const { Product } = require('../models/Product');
const { auth, adminOnly } = require('../middleware/auth');
const { getDailySummary, getWeeklySummary, buildCloseMessage } = require('../services/cash-register');
const { sendMessage } = require('../services/whatsapp');
const User = require('../models/User');

// ── Stats principales ──────────────────────────────────────────────────────
router.get('/', auth, async (req, res) => {
  try {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
    const startOfWeek = new Date(); startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay()); startOfWeek.setHours(0, 0, 0, 0);
    const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);

    const prevMonthStart = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    const prevMonthEnd = new Date(today.getFullYear(), today.getMonth(), 0, 23, 59, 59);

    const [todayOrders, weekOrders, monthOrders, prevMonthOrders, pendingOrders] = await Promise.all([
      Order.find({ createdAt: { $gte: today, $lt: tomorrow }, status: { $ne: 'cancelled' } }),
      Order.find({ createdAt: { $gte: startOfWeek }, status: { $ne: 'cancelled' } }),
      Order.find({ createdAt: { $gte: startOfMonth }, status: { $ne: 'cancelled' } }),
      Order.find({ createdAt: { $gte: prevMonthStart, $lte: prevMonthEnd }, status: { $ne: 'cancelled' } }),
      Order.find({ status: { $in: ['pending', 'confirmed', 'preparing'] } })
        .populate('client', 'name phone whatsapp').sort({ createdAt: -1 }).limit(10)
    ]);

    const todayRevenue = todayOrders.reduce((s, o) => s + o.total, 0);
    const weekRevenue = weekOrders.reduce((s, o) => s + o.total, 0);
    const monthRevenue = monthOrders.reduce((s, o) => s + o.total, 0);
    const prevMonthRevenue = prevMonthOrders.reduce((s, o) => s + o.total, 0);

    // Tendencias
    const revenueTrend = prevMonthRevenue > 0 ? Math.round(((monthRevenue - prevMonthRevenue) / prevMonthRevenue) * 100) : null;
    const ordersTrend = prevMonthOrders.length > 0 ? Math.round(((monthOrders.length - prevMonthOrders.length) / prevMonthOrders.length) * 100) : null;

    // Tiempos de entrega del mes
    const deliveryTimes = monthOrders
      .filter(o => o.status === 'delivered' && o.receivedAt && o.deliveredAt)
      .map(o => Math.round((new Date(o.deliveredAt) - new Date(o.receivedAt)) / 60000));
    const avgDeliveryTime = deliveryTimes.length > 0
      ? Math.round(deliveryTimes.reduce((s, t) => s + t, 0) / deliveryTimes.length)
      : null;

    // Métodos de pago del mes
    const paymentMethods = monthOrders.reduce((acc, o) => {
      acc[o.paymentMethod] = (acc[o.paymentMethod] || 0) + o.total;
      return acc;
    }, {});

    res.json({
      today: { orders: todayOrders.length, revenue: todayRevenue },
      week: { orders: weekOrders.length, revenue: weekRevenue },
      month: {
        orders: monthOrders.length,
        revenue: monthRevenue,
        avgTicket: monthOrders.length > 0 ? Math.round(monthRevenue / monthOrders.length) : 0,
        revenueTrend,
        ordersTrend,
        avgDeliveryTime,
        paymentMethods
      },
      prevMonth: { orders: prevMonthOrders.length, revenue: prevMonthRevenue },
      pending: pendingOrders
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── Sales stats mensuales con gráficos ───────────────────────────────────
router.get('/sales', auth, async (req, res) => {
  try {
    const { month, year } = req.query;
    const m = parseInt(month) || new Date().getMonth() + 1;
    const y = parseInt(year) || new Date().getFullYear();
    const start = new Date(y, m - 1, 1);
    const end = new Date(y, m, 0, 23, 59, 59);

    // Mes anterior para comparación
    const prevStart = new Date(y, m - 2, 1);
    const prevEnd = new Date(y, m - 1, 0, 23, 59, 59);

    const [orders, prevOrders] = await Promise.all([
      Order.find({ createdAt: { $gte: start, $lte: end }, status: { $ne: 'cancelled' } })
        .populate('client', 'name whatsapp totalOrders totalSpent'),
      Order.find({ createdAt: { $gte: prevStart, $lte: prevEnd }, status: { $ne: 'cancelled' } })
    ]);

    // Ventas por día del mes (para gráfico de barras)
    const daysInMonth = new Date(y, m, 0).getDate();
    const salesByDay = Array.from({ length: daysInMonth }, (_, i) => ({
      day: i + 1,
      label: `${i + 1}`,
      revenue: 0,
      orders: 0
    }));
    orders.forEach(o => {
      const day = new Date(o.createdAt).getDate() - 1;
      if (salesByDay[day]) {
        salesByDay[day].revenue += o.total;
        salesByDay[day].orders += 1;
      }
    });

    // Métodos de pago (para pie chart)
    const paymentData = orders.reduce((acc, o) => {
      const key = o.paymentMethod || 'efectivo';
      if (!acc[key]) acc[key] = { name: key, value: 0, count: 0 };
      acc[key].value += o.total;
      acc[key].count += 1;
      return acc;
    }, {});

    // Top productos
    const productSales = {};
    orders.forEach(order => {
      order.items.forEach(item => {
        const key = `${item.productName} ${item.variant}`.trim();
        if (!productSales[key]) productSales[key] = { name: key, units: 0, revenue: 0 };
        productSales[key].units += item.quantity;
        productSales[key].revenue += item.subtotal || 0;
      });
    });
    const top5 = Object.values(productSales).sort((a, b) => b.units - a.units).slice(0, 5);

    // Tiempos de entrega
    const deliveryTimes = orders
      .filter(o => o.status === 'delivered' && o.receivedAt && o.deliveredAt)
      .map(o => ({
        orderNumber: o.orderNumber,
        minutes: Math.round((new Date(o.deliveredAt) - new Date(o.receivedAt)) / 60000),
        day: new Date(o.createdAt).getDate()
      }));
    const avgDeliveryTime = deliveryTimes.length > 0
      ? Math.round(deliveryTimes.reduce((s, t) => s + t.minutes, 0) / deliveryTimes.length)
      : null;

    // Ranking clientes
    const clientMap = {};
    orders.forEach(o => {
      if (!o.client) return;
      const id = o.client._id.toString();
      if (!clientMap[id]) clientMap[id] = { name: o.client.name, whatsapp: o.client.whatsapp, orders: 0, spent: 0, totalOrders: o.client.totalOrders, totalSpent: o.client.totalSpent };
      clientMap[id].orders += 1;
      clientMap[id].spent += o.total;
    });
    const topClients = Object.values(clientMap).sort((a, b) => b.spent - a.spent).slice(0, 5);

    // Distribución de ganancias — sobre ganancia NETA
    const Config = require('../models/Config');
    const { Product } = require('../models/Product');

    const users = await User.find({ active: true, profitShare: { $gt: 0 } }).select('name profitShare');
    const totalRevenue = orders.reduce((s, o) => s + o.total, 0);

    // 1. Costo de productos vendidos (realTotalCost × quantity por ítem)
    const productIds = [...new Set(orders.flatMap(o => o.items.map(i => i.product?.toString()).filter(Boolean)))];
    const products = await Product.find({ _id: { $in: productIds } }).select('_id realTotalCost');
    const costMap = {};
    products.forEach(p => { costMap[p._id.toString()] = p.realTotalCost || 0; });
    const productsCost = orders.reduce((sum, o) =>
      sum + o.items.reduce((s, item) => s + (costMap[item.product?.toString()] || 0) * item.quantity, 0), 0
    );

    // 2. Gastos fijos del mes desde Config
    const fixedCfg = await Config.findOne({ key: 'fixedExpenses' });
    const fixedExpenses = fixedCfg?.value || {};
    const fixedTotal = Object.values(fixedExpenses).reduce((s, v) => s + Number(v || 0), 0);

    // 3. Ganancia neta = ingresos - costo productos - gastos fijos
    const netProfit = Math.max(0, Math.round(totalRevenue - productsCost - fixedTotal));

    const profitDistribution = users.map(u => ({
      name: u.name,
      percent: u.profitShare,
      amount: Math.round(netProfit * u.profitShare / 100)
    }));

    const prevRevenue = prevOrders.reduce((s, o) => s + o.total, 0);
    const revenueTrend = prevRevenue > 0 ? Math.round(((totalRevenue - prevRevenue) / prevRevenue) * 100) : null;

    // Descuento total por cupones del mes
    const totalCouponDiscount = orders
      .filter(o => o.coupon)
      .reduce((s, o) => s + (o.discountAmount || 0), 0);
    const ordersWithCoupon = orders.filter(o => o.coupon).length;
    const grossRevenue = totalRevenue + totalCouponDiscount;

    res.json({
      orders: orders.length,
      totalRevenue,
      netProfit,
      productsCost: Math.round(productsCost),
      fixedTotal: Math.round(fixedTotal),
      avgTicket: orders.length > 0 ? Math.round(totalRevenue / orders.length) : 0,
      revenueTrend,
      totalCouponDiscount,
      ordersWithCoupon,
      grossRevenue,
      salesByDay,
      paymentMethods: Object.values(paymentData),
      top5,
      avgDeliveryTime,
      deliveryTimes,
      topClients,
      profitDistribution,
      prevMonth: { orders: prevOrders.length, revenue: prevRevenue }
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── Caja diaria ────────────────────────────────────────────────────────────
router.get('/cash', auth, adminOnly, async (req, res) => {
  try {
    const { date } = req.query;
    const summary = await getDailySummary(date);
    res.json(summary);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get('/cash/week', auth, adminOnly, async (req, res) => {
  try {
    const summaries = await getWeeklySummary();
    res.json(summaries);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Cierre de caja — envía WhatsApp al dueño
router.post('/cash/close', auth, adminOnly, async (req, res) => {
  try {
    const { ownerPhone, date } = req.body;
    const summary = await getDailySummary(date);
    const message = buildCloseMessage(summary);

    let waSent = false;
    if (ownerPhone) {
      const result = await sendMessage(ownerPhone, message);
      waSent = result.success;
    }

    res.json({ summary, message, waSent });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

module.exports = router;
// ── GET reporte mensual para PDF ───────────────────────────────────────────
router.get('/report', auth, adminOnly, async (req, res) => {
  try {
    const month = parseInt(req.query.month) || new Date().getMonth() + 1;
    const year = parseInt(req.query.year) || new Date().getFullYear();

    const start = new Date(year, month - 1, 1);
    const end = new Date(year, month, 0, 23, 59, 59);

    const orders = await Order.find({
      createdAt: { $gte: start, $lte: end },
      status: { $ne: 'cancelled' }
    }).populate('client', 'name whatsapp');

    const cancelledOrders = await Order.find({
      createdAt: { $gte: start, $lte: end },
      status: 'cancelled'
    });

    // Ventas por día
    const salesByDay = {};
    orders.forEach(o => {
      const day = new Date(o.createdAt).getDate();
      if (!salesByDay[day]) salesByDay[day] = { orders: 0, revenue: 0 };
      salesByDay[day].orders++;
      salesByDay[day].revenue += o.total;
    });

    // Top productos
    const productMap = {};
    orders.forEach(o => {
      o.items?.forEach(item => {
        const key = `${item.productName} ${item.variant || ''}`.trim();
        if (!productMap[key]) productMap[key] = { name: key, units: 0, revenue: 0 };
        productMap[key].units += item.quantity;
        productMap[key].revenue += item.unitPrice * item.quantity;
      });
    });
    const topProducts = Object.values(productMap).sort((a, b) => b.revenue - a.revenue).slice(0, 10);

    // Métodos de pago
    const paymentMap = { efectivo: { count: 0, total: 0 }, transferencia: { count: 0, total: 0 } };
    orders.forEach(o => {
      const m = o.paymentMethod || 'efectivo';
      if (paymentMap[m]) { paymentMap[m].count++; paymentMap[m].total += o.total; }
    });

    // Top clientes
    const clientMap = {};
    orders.forEach(o => {
      const id = o.client?._id?.toString() || o.client?.toString();
      if (!id) return;
      if (!clientMap[id]) clientMap[id] = { name: o.client?.name || 'N/A', orders: 0, spent: 0 };
      clientMap[id].orders++;
      clientMap[id].spent += o.total;
    });
    const topClients = Object.values(clientMap).sort((a, b) => b.spent - a.spent).slice(0, 10);

    // Gastos fijos
    const Config = require('../models/Config');
    const fixedCfg = await Config.findOne({ key: 'fixedExpenses' });
    const fixedExpenses = fixedCfg?.value || {};
    const totalFixed = Object.values(fixedExpenses).reduce((s, v) => s + Number(v || 0), 0);

    // Distribución ganancias
    const userDistrib = await User.find({ active: true, profitPercent: { $gt: 0 } });

    const totalRevenue = orders.reduce((s, o) => s + o.total, 0);
    const totalCouponDiscount = orders.reduce((s, o) => s + (o.discountAmount || 0), 0);
    const productsCost = orders.reduce((s, o) => s + (o.items?.reduce((ss, i) => ss + (i.totalCost || 0) * i.quantity, 0) || 0), 0);
    const netProfit = totalRevenue - totalCouponDiscount - productsCost - totalFixed;
    const avgTicket = orders.length > 0 ? Math.round(totalRevenue / orders.length) : 0;

    res.json({
      period: { month, year, monthName: ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'][month-1] },
      summary: {
        totalOrders: orders.length,
        cancelledOrders: cancelledOrders.length,
        totalRevenue,
        avgTicket,
        totalCouponDiscount,
        productsCost,
        totalFixed,
        netProfit
      },
      salesByDay,
      topProducts,
      topClients,
      paymentMethods: paymentMap,
      fixedExpenses,
      userDistribution: userDistrib.map(u => ({ name: u.name, percent: u.profitPercent, amount: Math.round(netProfit * u.profitPercent / 100) }))
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});
