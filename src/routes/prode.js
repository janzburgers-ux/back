const express = require('express');
const router = express.Router();
const { auth, adminOnly } = require('../middleware/auth');
const { ProdeMatch, Pronostico, ProdePoints, ProdeConfig } = require('../models/Prode');
const {
  getProdeConfig,
  isProdeActive,
  syncFixture,
  seedMockFixture,
  evaluateMatch,
  getRanking,
  getTotalPoints,
} = require('../services/prode.service');

// ── POST acceso al prode por número de WhatsApp (público, sin auth) ──────────
router.post('/acceso', async (req, res) => {
  try {
    let { whatsapp } = req.body;
    if (!whatsapp) return res.status(400).json({ message: 'Ingresá tu número de WhatsApp' });

    // Normalizar: limpiar caracteres no numéricos
    const clean = whatsapp.replace(/\D/g, '');

    // Buscar cliente por whatsapp o phone (con variantes de formato)
    const { Client, Order } = require('../models/Order');
    const client = await Client.findOne({
      $or: [
        { whatsapp: { $regex: clean.slice(-8) } }, // últimos 8 dígitos
        { phone:    { $regex: clean.slice(-8) } },
      ],
      active: true,
    });

    if (!client) {
      return res.status(404).json({
        message: 'No encontramos ese número. ¿Seguro que compraste con este WhatsApp?'
      });
    }

    // Verificar que tenga al menos un pedido
    const pedidos = await Order.countDocuments({ client: client._id });
    if (pedidos === 0) {
      return res.status(403).json({
        message: 'Para participar del prode necesitás haber realizado al menos un pedido.'
      });
    }

    res.json({
      clientId: client._id,
      nombre: client.name.split(' ')[0],
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── GET config del prode (público — para mostrar/ocultar banner en /pedido) ───
router.get('/config', async (req, res) => {
  try {
    const cfg = await getProdeConfig();
    res.json(cfg);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── PUT actualizar config (solo admin) ───────────────────────────────────────
router.put('/config', auth, adminOnly, async (req, res) => {
  try {
    const cfg = await ProdeConfig.findOneAndUpdate(
      { key: 'prode' },
      { $set: { value: req.body } },
      { upsert: true, new: true }
    );
    res.json(cfg.value);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── GET fixture completo ──────────────────────────────────────────────────────
router.get('/fixture', auth, async (req, res) => {
  try {
    const { stage, group, status } = req.query;
    const filter = {};
    if (stage)  filter.stage  = stage;
    if (group)  filter.group  = group;
    if (status) filter.status = status;
    const matches = await ProdeMatch.find(filter).sort({ matchDate: 1 });
    res.json(matches);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── POST sync fixture desde API (solo admin) ─────────────────────────────────
router.post('/fixture/sync', auth, adminOnly, async (req, res) => {
  try {
    const result = await syncFixture();
    res.json(result);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── POST seed fixture mockeado (solo admin, solo si no hay datos) ─────────────
router.post('/fixture/seed-mock', auth, adminOnly, async (req, res) => {
  try {
    await seedMockFixture();
    res.json({ message: 'Fixture mockeado insertado' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── PUT actualizar resultado de un partido manualmente (solo admin) ───────────
router.put('/fixture/:id/resultado', auth, adminOnly, async (req, res) => {
  try {
    const { homeScore, awayScore } = req.body;
    const winner = homeScore > awayScore ? 'home' : awayScore > homeScore ? 'away' : 'draw';
    const match = await ProdeMatch.findByIdAndUpdate(
      req.params.id,
      { homeScore, awayScore, winner, status: 'finished' },
      { new: true }
    );
    // Evaluar pronósticos automáticamente
    await evaluateMatch(match._id);
    res.json(match);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── GET pronósticos de un cliente ─────────────────────────────────────────────
// Ruta pública para el cliente (usa clientId desde query o body)
router.get('/pronosticos/:clientId', async (req, res) => {
  try {
    const pronosticos = await Pronostico.find({ clientId: req.params.clientId })
      .populate('matchId');
    res.json(pronosticos);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── POST guardar/actualizar pronóstico de un cliente ─────────────────────────
router.post('/pronosticos', async (req, res) => {
  try {
    const { clientId, matchId, predictedWinner, predictedHome, predictedAway } = req.body;
    if (!clientId || !matchId || !predictedWinner) {
      return res.status(400).json({ message: 'Faltan campos requeridos' });
    }

    // Verificar que el partido no haya empezado (cutoff)
    const match = await ProdeMatch.findById(matchId);
    if (!match) return res.status(404).json({ message: 'Partido no encontrado' });
    if (match.status !== 'scheduled') {
      return res.status(400).json({ message: 'El partido ya comenzó, no se pueden modificar pronósticos' });
    }

    const cfg = await getProdeConfig();
    const cutoffMs = (cfg.cutoffMinutes || 30) * 60 * 1000;
    if (new Date(match.matchDate) - new Date() < cutoffMs) {
      return res.status(400).json({ message: `Pronósticos bloqueados ${cfg.cutoffMinutes || 30} minutos antes del partido` });
    }

    const pronostico = await Pronostico.findOneAndUpdate(
      { clientId, matchId },
      { predictedWinner, predictedHome: predictedHome ?? null, predictedAway: predictedAway ?? null, evaluated: false, pointsEarned: 0 },
      { upsert: true, new: true }
    );
    res.json(pronostico);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── GET ranking general (admin) ───────────────────────────────────────────────
router.get('/ranking', auth, async (req, res) => {
  try {
    const ranking = await getRanking();
    res.json(ranking);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── GET ranking público — top 5, sin auth, solo nombre y total ────────────────
router.get('/ranking/publico', async (req, res) => {
  try {
    const ranking = await getRanking();
    const top5 = ranking.slice(0, 5).map((r, i) => ({
      posicion: i + 1,
      nombre: r.nombre,
      totalPuntos: r.totalPuntos,
    }));
    res.json(top5);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── GET historial de puntos de un cliente ─────────────────────────────────────
router.get('/puntos/:clientId', async (req, res) => {
  try {
    const historial = await ProdePoints.find({ clientId: req.params.clientId })
      .sort({ createdAt: -1 })
      .limit(50);
    const total = await getTotalPoints(req.params.clientId);
    res.json({ historial, total });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── POST evaluar todos los partidos terminados pendientes (solo admin) ─────────
router.post('/evaluar', auth, adminOnly, async (req, res) => {
  try {
    const matches = await ProdeMatch.find({ status: 'finished' });
    let evaluated = 0;
    for (const m of matches) {
      await evaluateMatch(m._id);
      evaluated++;
    }
    res.json({ evaluated });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── GET estadísticas del prode para el admin ──────────────────────────────────
router.get('/stats', auth, adminOnly, async (req, res) => {
  try {
    const [totalParticipantes, totalPartidos, totalPronosticos, totalPuntos] = await Promise.all([
      ProdePoints.distinct('clientId').then(r => r.length),
      ProdeMatch.countDocuments(),
      Pronostico.countDocuments(),
      ProdePoints.aggregate([{ $group: { _id: null, total: { $sum: '$puntos' } } }]).then(r => r[0]?.total || 0),
    ]);
    const lider = await getRanking().then(r => r[0] || null);
    res.json({ totalParticipantes, totalPartidos, totalPronosticos, totalPuntos, lider });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── GET bonificaciones ────────────────────────────────────────────────────────
router.get('/bonificaciones', auth, adminOnly, async (req, res) => {
  try {
    const cfg = await ProdeConfig.findOne({ key: 'prode' });
    res.json(cfg?.value?.bonificaciones || []);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── POST agregar bonificación ─────────────────────────────────────────────────
router.post('/bonificaciones', auth, adminOnly, async (req, res) => {
  try {
    const { tipo, descripcion, productoId, productoNombre, montoMinimo, puntos } = req.body;
    if (!tipo || !puntos) return res.status(400).json({ message: 'Faltan campos requeridos' });

    const nueva = { tipo, descripcion, productoId, productoNombre, montoMinimo: Number(montoMinimo) || 0, puntos: Number(puntos), activa: true };

    let cfg = await ProdeConfig.findOne({ key: 'prode' });
    if (!cfg) cfg = await ProdeConfig.create({ key: 'prode', value: {} });

    const bonificaciones = cfg.value?.bonificaciones || [];
    bonificaciones.push(nueva);

    await ProdeConfig.findOneAndUpdate(
      { key: 'prode' },
      { $set: { 'value.bonificaciones': bonificaciones } },
      { new: true }
    );

    res.json(nueva);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── PUT actualizar bonificación (por índice) ──────────────────────────────────
router.put('/bonificaciones/:index', auth, adminOnly, async (req, res) => {
  try {
    const idx = Number(req.params.index);
    const cfg = await ProdeConfig.findOne({ key: 'prode' });
    if (!cfg) return res.status(404).json({ message: 'Config no encontrada' });

    const bonificaciones = cfg.value?.bonificaciones || [];
    if (idx < 0 || idx >= bonificaciones.length) return res.status(404).json({ message: 'Bonificación no encontrada' });

    bonificaciones[idx] = { ...bonificaciones[idx], ...req.body };

    await ProdeConfig.findOneAndUpdate(
      { key: 'prode' },
      { $set: { 'value.bonificaciones': bonificaciones } },
      { new: true }
    );

    res.json(bonificaciones[idx]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── DELETE bonificación (por índice) ─────────────────────────────────────────
router.delete('/bonificaciones/:index', auth, adminOnly, async (req, res) => {
  try {
    const idx = Number(req.params.index);
    const cfg = await ProdeConfig.findOne({ key: 'prode' });
    if (!cfg) return res.status(404).json({ message: 'Config no encontrada' });

    const bonificaciones = cfg.value?.bonificaciones || [];
    if (idx < 0 || idx >= bonificaciones.length) return res.status(404).json({ message: 'Bonificación no encontrada' });

    bonificaciones.splice(idx, 1);

    await ProdeConfig.findOneAndUpdate(
      { key: 'prode' },
      { $set: { 'value.bonificaciones': bonificaciones } },
      { new: true }
    );

    res.json({ deleted: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

module.exports = router;