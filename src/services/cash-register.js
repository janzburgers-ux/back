const { Order } = require('../models/Order');
const { sendMessage } = require('./whatsapp');

// Obtener resumen de caja para una fecha (YYYY-MM-DD, default: hoy en AR)
async function getDailySummary(date) {
  let dateStr;
  if (typeof date === 'string' && date.match(/^\d{4}-\d{2}-\d{2}$/)) {
    dateStr = date;
  } else {
    const d = date ? new Date(date) : new Date();
    const ar = new Date(d.toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
    dateStr = `${ar.getFullYear()}-${String(ar.getMonth() + 1).padStart(2, '0')}-${String(ar.getDate()).padStart(2, '0')}`;
  }
  const start = new Date(dateStr + 'T00:00:00-03:00');
  const end   = new Date(dateStr + 'T23:59:59.999-03:00');

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
    date: dateStr,
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

// Resumen semanal (últimos 7 días en timezone Argentina)
async function getWeeklySummary() {
  const days = [];
  for (let i = 6; i >= 0; i--) {
    // Usar timezone Argentina para no confundir días cerca de medianoche UTC
    const arNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
    arNow.setDate(arNow.getDate() - i);
    const y = arNow.getFullYear();
    const m = String(arNow.getMonth() + 1).padStart(2, '0');
    const d = String(arNow.getDate()).padStart(2, '0');
    days.push(`${y}-${m}-${d}`);
  }

  const summaries = await Promise.all(days.map(dateStr => getDailySummary(dateStr)));
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
