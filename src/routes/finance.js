const express = require('express');
const router = express.Router();
const Finance = require('../models/Finance');
const { auth, adminOnly } = require('../middleware/auth');

// Buckets por defecto
const DEFAULT_BUCKETS = [
  { key: 'produccion',   label: 'Producción',    emoji: '🥩', percent: 40, active: true, order: 0, description: 'Reposición de ingredientes y materia prima' },
  { key: 'gastos_fijos', label: 'Gastos fijos',  emoji: '🏠', percent: 20, active: true, order: 1, description: 'Alquiler, luz, gas, agua' },
  { key: 'ayudante',     label: 'Ayudante',       emoji: '👷', percent: 0,  active: false, order: 2, description: 'Costo del ayudante cuando lo necesitás (se resta antes de distribuir)' },
  { key: 'reinversion',  label: 'Reinversión',    emoji: '📈', percent: 15, active: true, order: 3, description: 'Para crecer el negocio' },
  { key: 'ganancia',     label: 'Ganancia tuya',  emoji: '💰', percent: 25, active: true, order: 4, description: 'Tu retribución como dueño' },
  { key: 'impuestos',    label: 'Impuestos',      emoji: '🏛️', percent: 0,  active: false, order: 5, description: 'Activá cuando estés inscripto' },
];

// ── GET config ────────────────────────────────────────────────────────────────
router.get('/config', auth, adminOnly, async (req, res) => {
  try {
    let finance = await Finance.findOne();
    if (!finance) {
      finance = new Finance({ buckets: DEFAULT_BUCKETS });
      await finance.save();
    }
    res.json(finance);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── PUT actualizar buckets ────────────────────────────────────────────────────
router.put('/buckets', auth, adminOnly, async (req, res) => {
  try {
    const { buckets } = req.body;

    // Validar que los activos sumen 100%
    const activeTotal = buckets
      .filter(b => b.active && b.key !== 'ayudante')
      .reduce((s, b) => s + Number(b.percent || 0), 0);

    if (Math.round(activeTotal) !== 100) {
      return res.status(400).json({
        message: `Los porcentajes activos deben sumar 100%. Actualmente suman ${activeTotal}%.`
      });
    }

    let finance = await Finance.findOne();
    if (!finance) finance = new Finance({});
    finance.buckets = buckets;
    await finance.save();
    res.json(finance);
  } catch (err) { res.status(400).json({ message: err.message }); }
});

// ── POST registrar distribución de una noche ──────────────────────────────────
router.post('/night', auth, adminOnly, async (req, res) => {
  try {
    const { date, totalRevenue, ayudante, notes } = req.body;

    let finance = await Finance.findOne();
    if (!finance) finance = new Finance({ buckets: DEFAULT_BUCKETS });

    const ayudanteCost = Number(ayudante || 0);
    const base = Math.max(0, Number(totalRevenue) - ayudanteCost);

    // Calcular distribución
    const distribution = finance.buckets
      .filter(b => b.active && b.key !== 'ayudante')
      .map(b => ({
        key:     b.key,
        label:   b.label,
        emoji:   b.emoji,
        percent: b.percent,
        amount:  Math.round(base * b.percent / 100),
      }));

    // Agregar ayudante si corresponde
    if (ayudanteCost > 0) {
      distribution.unshift({
        key: 'ayudante', label: 'Ayudante', emoji: '👷',
        percent: 0, amount: ayudanteCost
      });
    }

    const record = {
      date: new Date(date),
      totalRevenue: Number(totalRevenue),
      ayudante: ayudanteCost,
      distribution,
      notes: notes || '',
    };

    finance.nightRecords.push(record);
    await finance.save();

    res.status(201).json(record);
  } catch (err) { res.status(400).json({ message: err.message }); }
});

// ── GET historial de noches ───────────────────────────────────────────────────
router.get('/nights', auth, adminOnly, async (req, res) => {
  try {
    const { month, year } = req.query;
    const finance = await Finance.findOne();
    if (!finance) return res.json([]);

    let records = finance.nightRecords;

    if (month && year) {
      const m = parseInt(month);
      const y = parseInt(year);
      records = records.filter(r => {
        const d = new Date(new Date(r.date).toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
        return d.getMonth() + 1 === m && d.getFullYear() === y;
      });
    }

    res.json(records.sort((a, b) => new Date(b.date) - new Date(a.date)));
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── DELETE noche ──────────────────────────────────────────────────────────────
router.delete('/night/:id', auth, adminOnly, async (req, res) => {
  try {
    const finance = await Finance.findOne();
    if (!finance) return res.status(404).json({ message: 'No encontrado' });
    finance.nightRecords = finance.nightRecords.filter(r => r._id.toString() !== req.params.id);
    await finance.save();
    res.json({ message: 'Registro eliminado' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── GET resumen del mes ───────────────────────────────────────────────────────
router.get('/summary', auth, adminOnly, async (req, res) => {
  try {
    const { month, year } = req.query;
    const m = parseInt(month) || new Date().getMonth() + 1;
    const y = parseInt(year) || new Date().getFullYear();

    const finance = await Finance.findOne();
    if (!finance) return res.json({ totalRevenue: 0, buckets: [], nights: 0 });

    const records = finance.nightRecords.filter(r => {
      // Use Argentina timezone for date comparison
      const d = new Date(new Date(r.date).toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
      return d.getMonth() + 1 === m && d.getFullYear() === y;
    });
    console.log(`[Finance Summary] ${m}/${y}: ${records.length} noches encontradas de ${finance.nightRecords.length} totales`);

    const totalRevenue = records.reduce((s, r) => s + r.totalRevenue, 0);

    // Acumular por bucket
    const bucketTotals = {};
    records.forEach(r => {
      r.distribution.forEach(d => {
        if (!bucketTotals[d.key]) bucketTotals[d.key] = { ...d, amount: 0 };
        bucketTotals[d.key].amount += d.amount;
      });
    });

    res.json({
      month: m, year: y,
      nights: records.length,
      totalRevenue,
      buckets: Object.values(bucketTotals),
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── GET total de ventas de una fecha desde los pedidos ───────────────────────
router.get('/daily-revenue', auth, adminOnly, async (req, res) => {
  try {
    const { date } = req.query;
    const { Order } = require('../models/Order');

    const d = date ? new Date(date) : new Date();
    // Ajustar a zona horaria Argentina
    const start = new Date(new Date(d).toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setHours(23, 59, 59, 999);

    const orders = await Order.find({
      createdAt: { $gte: start, $lte: end },
      status: 'delivered'
    });

    const totalRevenue = orders.reduce((s, o) => s + o.total, 0);
    const orderCount   = orders.length;

    res.json({ date, totalRevenue, orderCount });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

module.exports = router;