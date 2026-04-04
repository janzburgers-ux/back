// ── GET /api/public/slots-availability ───────────────────────────────────────
// Devuelve cuántos pedidos programados hay por slot en el día actual (AR),
// y el límite máximo configurado por el admin.
// Se agrega como ruta adicional en public.js

const express = require('express');
const router = express.Router();
const { Order } = require('../models/Order');
const Config = require('../models/Config');

// Helper: rango del día actual en Argentina
function todayRangeAR() {
  const now = new Date();
  const ar = new Date(now.toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
  const start = new Date(ar.getFullYear(), ar.getMonth(), ar.getDate(), 0, 0, 0);
  const end   = new Date(ar.getFullYear(), ar.getMonth(), ar.getDate(), 23, 59, 59);
  // Convertir a UTC para query
  const offsetMs = ar.getTime() - now.getTime();
  return {
    start: new Date(start.getTime() - offsetMs),
    end:   new Date(end.getTime()   - offsetMs)
  };
}

router.get('/slots-availability', async (req, res) => {
  try {
    const cfg = await Config.findOne({ key: 'maxOrdersPerSlot' });
    const maxOrdersPerSlot = cfg?.value || 5;

    const { start, end } = todayRangeAR();

    // Traer pedidos programados de hoy que no estén cancelados
    const scheduledOrders = await Order.find({
      isScheduled: true,
      scheduledFor: { $gte: start, $lte: end },
      status: { $ne: 'cancelled' }
    }).select('scheduledFor');

    // Contar por slot (HH:MM)
    const occupancy = {};
    scheduledOrders.forEach(order => {
      if (!order.scheduledFor) return;
      const ar = new Date(order.scheduledFor.toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
      // Redondear al slot de 30 minutos más cercano hacia abajo
      const mins = ar.getHours() * 60 + ar.getMinutes();
      const slotMins = Math.floor(mins / 30) * 30;
      const hh = String(Math.floor(slotMins / 60)).padStart(2, '0');
      const mm = String(slotMins % 60).padStart(2, '0');
      const key = `${hh}:${mm}`;
      occupancy[key] = (occupancy[key] || 0) + 1;
    });

    res.json({ occupancy, maxOrdersPerSlot });
  } catch (err) {
    console.error('slots-availability error:', err);
    res.status(500).json({ occupancy: {}, maxOrdersPerSlot: 5 });
  }
});

module.exports = router;
