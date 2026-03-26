const { Order } = require('../models/Order');
const { sendMessage } = require('./whatsapp');

// Obtener resumen de caja para una fecha (default: hoy)
async function getDailySummary(date) {
  const d = date ? new Date(date) : new Date();
  const start = new Date(d); start.setHours(0, 0, 0, 0);
  const end = new Date(d); end.setHours(23, 59, 59, 999);

  const orders = await Order.find({
    createdAt: { $gte: start, $lte: end },
    status: { $ne: 'cancelled' }
  }).populate('client', 'name');

  const delivered = orders.filter(o => o.status === 'delivered');
  const pending = orders.filter(o => o.status !== 'delivered');

  const efectivo = delivered.filter(o => o.paymentMethod === 'efectivo').reduce((s, o) => s + o.total, 0);
  const transferencia = delivered.filter(o => o.paymentMethod === 'transferencia').reduce((s, o) => s + o.total, 0);
  const totalRevenue = efectivo + transferencia;

  // Tiempos de entrega (receivedAt → deliveredAt)
  const deliveryTimes = delivered
    .filter(o => o.receivedAt && o.deliveredAt)
    .map(o => Math.round((new Date(o.deliveredAt) - new Date(o.receivedAt)) / 60000));
  const avgDeliveryTime = deliveryTimes.length > 0
    ? Math.round(deliveryTimes.reduce((s, t) => s + t, 0) / deliveryTimes.length)
    : null;

  return {
    date: d.toISOString().split('T')[0],
    orders: { total: orders.length, delivered: delivered.length, pending: pending.length },
    revenue: { efectivo, transferencia, total: totalRevenue },
    avgDeliveryTime,
    deliveryTimes,
    ordersDetail: orders.map(o => ({
      orderNumber: o.orderNumber,
      client: o.client?.name,
      total: o.total,
      paymentMethod: o.paymentMethod,
      status: o.status,
      createdAt: o.createdAt
    }))
  };
}

// Resumen semanal (últimos 7 días operativos)
async function getWeeklySummary() {
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push(d);
  }

  const summaries = await Promise.all(days.map(d => getDailySummary(d)));
  return summaries;
}

// Formatear mensaje de cierre para WhatsApp
function buildCloseMessage(summary, ownerName = 'Jefe') {
  const fmt = n => `$${Number(n || 0).toLocaleString('es-AR')}`;
  const date = new Date(summary.date).toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });

  return (
    `🍔 *CIERRE DE CAJA — ${date.toUpperCase()}*\n\n` +
    `📦 Pedidos: *${summary.orders.delivered}* entregados / ${summary.orders.total} totales\n\n` +
    `💰 *INGRESOS:*\n` +
    `  💵 Efectivo: *${fmt(summary.revenue.efectivo)}*\n` +
    `  🏦 Transferencia: *${fmt(summary.revenue.transferencia)}*\n` +
    `  ━━━━━━━━━━━━━━\n` +
    `  TOTAL: *${fmt(summary.revenue.total)}*\n\n` +
    (summary.avgDeliveryTime ? `⏱ Tiempo promedio de entrega: *${summary.avgDeliveryTime} min*\n\n` : '') +
    `_Janz Burgers — Sistema de gestión_ 🔥`
  );
}

module.exports = { getDailySummary, getWeeklySummary, buildCloseMessage };
