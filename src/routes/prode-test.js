// ── RUTAS DE TESTING DEL PRODE (solo disponibles si NODE_ENV !== 'production') ─
// Registrar en server.js: app.use('/api/prode-test', require('./routes/prode-test'));
// IMPORTANTE: desactivar o eliminar este archivo antes del Mundial real.

const express = require('express');
const router  = express.Router();
const { auth, adminOnly } = require('../middleware/auth');
const { ProdeMatch, Pronostico, ProdePoints } = require('../models/Prode');
const { evaluateMatch, addProdePointsForOrder, getRanking, getProdeConfig } = require('../services/prode.service');

// Bloquear en producción
router.use((req, res, next) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({ message: 'Testing no disponible en producción.' });
  }
  next();
});

// ── GET /api/prode-test/estado ─────────────────────────────────────────────────
// Resumen completo del estado actual del prode para diagnosticar
router.get('/estado', auth, adminOnly, async (req, res) => {
  try {
    const [partidos, pronosticos, puntos, ranking, config] = await Promise.all([
      ProdeMatch.countDocuments(),
      Pronostico.countDocuments(),
      ProdePoints.countDocuments(),
      getRanking(),
      getProdeConfig(),
    ]);

    const porEstado = await ProdeMatch.aggregate([
      { $group: { _id: '$status', count: { $sum: 1 } } }
    ]);

    res.json({
      config: {
        enabled: config.enabled,
        pointsWinner: config.pointsWinner,
        pointsExact: config.pointsExact,
        pointsPerOrder: config.pointsPerOrder,
        cutoffMinutes: config.cutoffMinutes,
      },
      fixture: {
        total: partidos,
        porEstado: Object.fromEntries(porEstado.map(e => [e._id, e.count])),
      },
      pronosticos,
      registrosDePuntos: puntos,
      rankingParticipantes: ranking.length,
      ranking: ranking.slice(0, 10).map((r, i) => ({
        pos: i + 1,
        nombre: r.nombre,
        total: r.totalPuntos,
        pronos: r.puntosPronosticos,
        compras: r.puntosCompras,
      })),
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── POST /api/prode-test/simular-resultado ─────────────────────────────────────
// Marca un partido como terminado y evalúa pronósticos
// Body: { matchId, homeScore, awayScore }
router.post('/simular-resultado', auth, adminOnly, async (req, res) => {
  try {
    const { matchId, homeScore, awayScore } = req.body;
    if (!matchId || homeScore == null || awayScore == null) {
      return res.status(400).json({ message: 'Faltan: matchId, homeScore, awayScore' });
    }

    const winner = homeScore > awayScore ? 'home' : awayScore > homeScore ? 'away' : 'draw';
    const match  = await ProdeMatch.findByIdAndUpdate(
      matchId,
      { homeScore, awayScore, winner, status: 'finished' },
      { new: true }
    );
    if (!match) return res.status(404).json({ message: 'Partido no encontrado' });

    await evaluateMatch(match._id);

    const pronosticosEvaluados = await Pronostico.find({ matchId: match._id, evaluated: true });
    const conPuntos = pronosticosEvaluados.filter(p => p.pointsEarned > 0);

    res.json({
      ok: true,
      partido: `${match.homeTeam} ${homeScore}-${awayScore} ${match.awayTeam}`,
      ganador: winner,
      pronosticosEvaluados: pronosticosEvaluados.length,
      acertaron: conPuntos.length,
      detalle: pronosticosEvaluados.map(p => ({
        clientId: p.clientId,
        predictedWinner: p.predictedWinner,
        predictedScore: p.predictedHome != null ? `${p.predictedHome}-${p.predictedAway}` : null,
        puntos: p.pointsEarned,
      })),
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── POST /api/prode-test/simular-compra ───────────────────────────────────────
// Simula una compra para un cliente y le asigna puntos del prode
// Body: { clientId, total, items? }
router.post('/simular-compra', auth, adminOnly, async (req, res) => {
  try {
    const { clientId, total = 5000, items = [] } = req.body;
    if (!clientId) return res.status(400).json({ message: 'Falta clientId' });

    // Crear un orderId ficticio para no romper la constraint
    const mongoose = require('mongoose');
    const fakeOrderId = new mongoose.Types.ObjectId();

    const result = await addProdePointsForOrder(clientId, fakeOrderId, total, items);
    if (!result) return res.status(400).json({ message: 'El prode no está activo o no se pudo asignar puntos.' });

    res.json({
      ok: true,
      clientId,
      totalSimulado: total,
      puntosAsignados: result.puntos,
      detalles: result.detalles,
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── DELETE /api/prode-test/limpiar-puntos ─────────────────────────────────────
// Borra TODOS los ProdePoints y resetea pronósticos evaluados (para re-testear)
router.delete('/limpiar-puntos', auth, adminOnly, async (req, res) => {
  try {
    const deletedPts  = await ProdePoints.deleteMany({});
    const resetPronos = await Pronostico.updateMany(
      { evaluated: true },
      { evaluated: false, pointsEarned: 0 }
    );
    res.json({
      ok: true,
      puntosEliminados: deletedPts.deletedCount,
      pronosticosReseteados: resetPronos.modifiedCount,
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── DELETE /api/prode-test/limpiar-pronosticos ────────────────────────────────
// Borra todos los pronósticos de un cliente (para re-pronosticar)
// Body: { clientId }
router.delete('/limpiar-pronosticos', auth, adminOnly, async (req, res) => {
  try {
    const { clientId } = req.body;
    if (!clientId) return res.status(400).json({ message: 'Falta clientId' });
    const result = await Pronostico.deleteMany({ clientId });
    res.json({ ok: true, eliminados: result.deletedCount });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── POST /api/prode-test/resetear-partido ─────────────────────────────────────
// Vuelve un partido a 'scheduled' para poder volver a testear
// Body: { matchId }
router.post('/resetear-partido', auth, adminOnly, async (req, res) => {
  try {
    const { matchId } = req.body;
    if (!matchId) return res.status(400).json({ message: 'Falta matchId' });
    await ProdeMatch.findByIdAndUpdate(matchId, {
      status: 'scheduled', homeScore: null, awayScore: null, winner: null
    });
    await Pronostico.updateMany({ matchId }, { evaluated: false, pointsEarned: 0 });
    await ProdePoints.deleteMany({ matchId });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

module.exports = router;