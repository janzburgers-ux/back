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
  resolveProdeStatus,
  markProdeRegistered,
  registerProdeGuest,
  findClientByPhone,
  getPremiosAdmin,
  normalizePhone,
  phoneKey,
} = require('../services/prode.service');

// ── POST registro invitado (nombre + WhatsApp, sin pedido previo) ─────────────
router.post('/registro', async (req, res) => {
  try {
    const { nombre, whatsapp } = req.body;
    if (!nombre?.trim() || !whatsapp) {
      return res.status(400).json({ message: 'Nombre y WhatsApp son requeridos' });
    }

    const { client, couponCode } = await registerProdeGuest({ nombre, whatsapp });
    const key = phoneKey(whatsapp);
    const { requestOTP } = require('../utils/otp');
    const result = requestOTP(key, String(client._id));

    if (!result.ok) {
      const secsLeft = Math.ceil((result.resendAt - Date.now()) / 1000);
      return res.status(429).json({ message: `Aguardá ${secsLeft} segundos antes de pedir otro código.` });
    }

    const cfg = await getProdeConfig();
    const guestPercent = cfg.guestCouponPercent || 20;

    const waNum = client.whatsapp || client.phone || normalizePhone(whatsapp);
    const { sendMessage } = require('../services/whatsapp');
    let msg =
      `🏆 *¡Bienvenido al Prode Janz!*\n\n` +
      `Tu código de verificación es: *${result.code}*\n\n` +
      `Válido por 5 minutos.\n\n`;
    if (couponCode) {
      msg += `🎟️ Tu cupón de invitado: *${couponCode}* (${guestPercent}% OFF en tu primera compra)\n\n`;
    }
    msg += `_Janz Burgers_ 🍔⚽`;
    await sendMessage(waNum, msg);

    res.json({
      sent: true,
      nombre: client.name.split(' ')[0],
      cuponInvitado: couponCode || null,
    });
  } catch (err) {
    res.status(err.message?.includes('activo') ? 403 : 500).json({ message: err.message });
  }
});

// ── POST acceso al prode por número de WhatsApp (legacy, sin OTP) ─────────────
router.post('/acceso', async (req, res) => {
  try {
    let { whatsapp } = req.body;
    if (!whatsapp) return res.status(400).json({ message: 'Ingresá tu número de WhatsApp' });

    const client = await findClientByPhone(whatsapp);
    if (!client) {
      return res.status(404).json({
        message: 'No encontramos este número. Registrate como invitado si nunca compraste en Janz.',
        code: 'CLIENT_NOT_FOUND',
      });
    }

    await markProdeRegistered(client._id);
    const estado = await resolveProdeStatus(client._id);

    res.json({
      clientId: client._id,
      nombre: client.name.split(' ')[0],
      estado,
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── POST solicitar código OTP (paso 1 del login con verificación) ─────────────
router.post('/acceso/codigo', async (req, res) => {
  try {
    let { whatsapp } = req.body;
    if (!whatsapp) return res.status(400).json({ message: 'Ingresá tu número de WhatsApp' });

    const key = phoneKey(whatsapp);
    const client = await findClientByPhone(whatsapp);

    if (!client) {
      return res.status(404).json({
        message: 'No encontramos este número. Registrate como invitado si nunca compraste en Janz.',
        code: 'CLIENT_NOT_FOUND',
      });
    }

    const { requestOTP } = require('../utils/otp');
    const result = requestOTP(key, String(client._id));

    if (!result.ok) {
      const secsLeft = Math.ceil((result.resendAt - Date.now()) / 1000);
      return res.status(429).json({ message: `Aguardá ${secsLeft} segundos antes de pedir otro código.` });
    }

    const { sendMessage } = require('../services/whatsapp');
    const waNum = client.whatsapp || client.phone || '';
    if (!waNum) return res.status(400).json({ message: 'No tenemos WhatsApp registrado para esta cuenta.' });

    await sendMessage(waNum,
      `🏆 *Prode Janz — Código de verificación*\n\n` +
      `Tu código es: *${result.code}*\n\n` +
      `Válido por 5 minutos. No lo compartas.\n\n` +
      `_Janz Burgers_ 🍔⚽`
    );

    res.json({ sent: true, nombre: client.name.split(' ')[0] });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── POST verificar código OTP (paso 2) ────────────────────────────────────────
router.post('/acceso/verificar', async (req, res) => {
  try {
    const { whatsapp, code } = req.body;
    if (!whatsapp || !code) return res.status(400).json({ message: 'Faltan datos' });

    const key = whatsapp.replace(/\D/g, '').slice(-8);
    const { verifyOTP } = require('../utils/otp');
    const result = verifyOTP(key, code);

    if (!result.ok) {
      if (result.reason === 'expired')   return res.status(400).json({ message: 'El código expiró. Pedí uno nuevo.' });
      if (result.reason === 'too_many')  return res.status(400).json({ message: 'Demasiados intentos fallidos. Pedí un código nuevo.' });
      if (result.reason === 'not_found') return res.status(400).json({ message: 'Código expirado. Pedí uno nuevo.' });
      const left = result.attemptsLeft;
      return res.status(400).json({ message: `Código incorrecto.${left > 0 ? ` Te quedan ${left} intento${left !== 1 ? 's' : ''}.` : ''}` });
    }

    const { Client } = require('../models/Order');
    const client = await Client.findById(result.clientId);
    if (!client) return res.status(404).json({ message: 'Cliente no encontrado' });

    await markProdeRegistered(client._id);
    const estado = await resolveProdeStatus(client._id);

    res.json({
      clientId: client._id,
      nombre: client.name.split(' ')[0],
      estado,
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── GET estado del participante (categoría, progreso, premio) ─────────────────
router.get('/estado/:clientId', async (req, res) => {
  try {
    const estado = await resolveProdeStatus(req.params.clientId);
    if (!estado) return res.status(404).json({ message: 'Participante no encontrado' });
    res.json(estado);
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

// ── GET fixture completo (público — lo necesita PublicProde.jsx sin token) ────
router.get('/fixture', async (req, res) => {
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
    // syncFixture nunca tira, devuelve { synced, error? } — lo exponemos completo
    if (result.error) {
      return res.status(502).json({ message: `API error: ${result.error}`, synced: 0 });
    }
    res.json(result);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── GET debug API — raw response de API-Football v3 (solo admin) ─────────────
router.get('/fixture/debug-api', auth, adminOnly, async (req, res) => {
  const axios = require('axios');
  const FOOTBALL_DATA_KEY = process.env.FOOTBALL_DATA_KEY;
  const url = 'https://api.football-data.org/v4/competitions/WC/matches';

  if (!FOOTBALL_DATA_KEY) {
    return res.json({
      ok: false,
      problema: 'FOOTBALL_DATA_KEY no esta definida en las variables de entorno. Registrate en football-data.org y agregala en Railway.',
    });
  }

  try {
    const resp = await axios.get(url, {
      headers: { 'X-Auth-Token': FOOTBALL_DATA_KEY },
      timeout: 12000,
    });
    const matches = resp.data?.matches || [];
    return res.json({
      ok:             true,
      httpStatus:     resp.status,
      url,
      cantidad:       matches.length,
      primer_partido: matches[0] || null,
    });
  } catch (err) {
    const status = err.response?.status;
    let problema = err.message;
    if (status === 403) problema = 'API key invalida o sin permisos para WC.';
    if (status === 429) problema = 'Rate limit (10 req/min). Esperá un momento.';
    if (status === 404) problema = 'Competicion WC no encontrada en este plan.';
    return res.json({
      ok:          false,
      problema,
      httpStatus:  status,
      apiResponse: err.response?.data,
      url,
    });
  }
});

// ── POST seed fixture mockeado (solo admin, solo si no hay datos) ─────────────
router.post('/fixture/seed-mock', auth, adminOnly, async (req, res) => {
  try {
    await seedMockFixture();
    res.json({ message: 'Fixture mockeado insertado' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── DELETE partidos mockeados (apiId empieza con "mock-") ────────────────────
router.delete('/fixture/mock', auth, adminOnly, async (req, res) => {
  try {
    const result = await ProdeMatch.deleteMany({ apiId: { $regex: /^mock-/ } });
    res.json({ deleted: result.deletedCount });
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

    // Si el partido ya había sido evaluado (con resultado anterior o incorrecto),
    // reseteamos todo para que la re-evaluación sea limpia.
    const yaEvaluados = await Pronostico.countDocuments({ matchId: match._id, evaluated: true });
    if (yaEvaluados > 0) {
      // Eliminar ProdePoints de pronósticos de este partido
      await ProdePoints.deleteMany({ matchId: match._id, tipo: 'pronostico' });
      // Resetear flag en los pronósticos
      await Pronostico.updateMany(
        { matchId: match._id },
        { $set: { evaluated: false, pointsEarned: 0 } }
      );
    }

    // Evaluar pronósticos con el resultado correcto
    await evaluateMatch(match._id);
    res.json(match);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── GET todas las predicciones de un partido (admin) ─────────────────────────
router.get('/pronosticos-admin', auth, adminOnly, async (req, res) => {
  try {
    const { matchId } = req.query;
    const { Client } = require('../models/Order');

    const filter = {};
    if (matchId) filter.matchId = matchId;

    const pronosticos = await Pronostico.find(filter)
      .populate('matchId')
      .lean();

    const clientIds = [...new Set(pronosticos.map(p => String(p.clientId)))];
    const clients = await Client.find({ _id: { $in: clientIds } }, 'name whatsapp phone').lean();
    const clientMap = {};
    clients.forEach(c => { clientMap[String(c._id)] = c; });

    const result = pronosticos.map(p => ({
      ...p,
      client: clientMap[String(p.clientId)] || null,
    }));

    res.json(result);
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

    // ── Equipos no confirmados → no se puede pronosticar ─────────────────
    if (match.teamsConfirmed === false) {
      return res.status(400).json({
        message: 'Los equipos de este partido aún no están confirmados. Podrás pronosticar una vez que se definan los clasificados.',
        code: 'TEAMS_NOT_CONFIRMED',
      });
    }

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

    await markProdeRegistered(clientId);

    res.json(pronostico);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── PUT confirmar equipos manualmente (admin) — cuando el sync tarda en actualizar ──
router.put('/fixture/:id/teams', auth, adminOnly, async (req, res) => {
  try {
    const { homeTeam, awayTeam, homeLogo, awayLogo } = req.body;
    if (!homeTeam || !awayTeam) {
      return res.status(400).json({ message: 'homeTeam y awayTeam son requeridos' });
    }
    const match = await ProdeMatch.findByIdAndUpdate(
      req.params.id,
      { homeTeam, awayTeam, teamsConfirmed: true,
        ...(homeLogo !== undefined && { homeLogo }),
        ...(awayLogo !== undefined && { awayLogo }),
      },
      { new: true }
    );
    if (!match) return res.status(404).json({ message: 'Partido no encontrado' });
    res.json(match);
  } catch (err) { res.status(500).json({ message: err.message }); }
});
// ── GET premios segmentados (admin) ───────────────────────────────────────────
router.get('/premios', auth, adminOnly, async (req, res) => {
  try {
    const premios = await getPremiosAdmin();
    res.json(premios);
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
    const top20 = ranking.slice(0, 20).map((r, i) => ({
      posicion:       i + 1,
      _id:            r.clientId,
      nombre:         r.apodo || r.nombre?.split(' ')[0] || r.nombre,
      totalPuntos:    r.totalPuntos,
      categoria:      r.categoriaLabel,
      elegibleTop3:   r.elegibleTop3,
    }));
    res.json(top20);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get('/ranking/posicion/:clientId', async (req, res) => {
  try {
    const ranking = await getRanking();
    const idx = ranking.findIndex(r => String(r.clientId) === req.params.clientId);
    res.json({
      posicion:    idx >= 0 ? idx + 1 : null,
      total:       ranking.length,
      totalPuntos: idx >= 0 ? ranking[idx].totalPuntos : 0,
    });
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


// ── GET lista completa de participantes con stats (admin) ─────────────────────
router.get('/participantes', auth, adminOnly, async (req, res) => {
  try {
    const { Client } = require('../models/Order');

    const clientIds = await Pronostico.distinct('clientId');
    if (clientIds.length === 0) return res.json([]);

    const clients = await Client.find({ _id: { $in: clientIds } }, 'name whatsapp phone prodeGuestCouponCode').lean();

    const ptsByClient = await ProdePoints.aggregate([
      { $match: { clientId: { $in: clientIds }, tipo: { $in: ['pronostico', 'bonificacion'] } } },
      { $group: {
        _id: '$clientId',
        total:         { $sum: '$puntos' },
        porPronostico: { $sum: { $cond: [{ $eq: ['$tipo', 'pronostico'] }, '$puntos', 0] } },
        porBonus:      { $sum: { $cond: [{ $eq: ['$tipo', 'bonificacion'] }, '$puntos', 0] } },
      }}
    ]);
    const ptsMap = {};
    ptsByClient.forEach(p => { ptsMap[String(p._id)] = p; });

    const statsByClient = await Pronostico.aggregate([
      { $match: { clientId: { $in: clientIds } } },
      { $group: {
        _id: '$clientId',
        total:    { $sum: 1 },
        acertados:{ $sum: { $cond: [{ $and: [{ $eq: ['$evaluated', true] }, { $gt: ['$pointsEarned', 0] }] }, 1, 0] } },
        exactos:  { $sum: { $cond: [
          { $and: [
            { $eq: ['$evaluated', true] },
            { $gt: ['$pointsEarned', 0] },
            { $ne: ['$predictedHome', null] },
          ]}, 1, 0
        ]}},
      }}
    ]);
    const statsMap = {};
    statsByClient.forEach(s => { statsMap[String(s._id)] = s; });

    const result = await Promise.all(clients.map(async c => {
      const cid = String(c._id);
      const status = await resolveProdeStatus(c._id);
      return {
        clientId: c._id,
        nombre:   c.name,
        whatsapp: c.whatsapp || c.phone || '',
        puntos:           ptsMap[cid]?.total         || 0,
        puntosPronostico: ptsMap[cid]?.porPronostico || 0,
        puntosBonus:      ptsMap[cid]?.porBonus      || 0,
        puntosCompra:     ptsMap[cid]?.porBonus      || 0,
        categoria:        status?.categoriaLabel || 'Invitado',
        premioSegmento:   status?.premioSegmento || 'invitado',
        elegibleTop3:     status?.elegibleTop3 || false,
        cuponInvitado:    c.prodeGuestCouponCode || status?.cuponInvitado || null,
        pronosticos: {
          total:     statsMap[cid]?.total     || 0,
          acertados: statsMap[cid]?.acertados || 0,
          exactos:   statsMap[cid]?.exactos   || 0,
        },
        entregasEnPeriodo: status?.entregasEnPeriodo || 0,
        pedidosEnPeriodo:  status?.entregasEnPeriodo || 0,
      };
    }));

    result.sort((a, b) => b.puntos - a.puntos);
    res.json(result);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── DELETE resetear predicciones de un cliente específico (admin/testing) ─────
router.delete('/reset-cliente/:clientId', auth, adminOnly, async (req, res) => {
  try {
    const { clientId } = req.params;
    const [p, pts] = await Promise.all([
      Pronostico.deleteMany({ clientId }),
      ProdePoints.deleteMany({ clientId }),
    ]);
    res.json({ pronosticosEliminados: p.deletedCount, puntosEliminados: pts.deletedCount });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── DELETE reset nuclear — borra TODOS los pronósticos y puntos (admin/testing) ─
router.delete('/reset-all', auth, adminOnly, async (req, res) => {
  try {
    const [p, pts] = await Promise.all([
      Pronostico.deleteMany({}),
      ProdePoints.deleteMany({}),
    ]);
    // No tocamos ProdeMatch — los scores vienen de la API y se regeneran solos
    res.json({ pronosticosEliminados: p.deletedCount, puntosEliminados: pts.deletedCount });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── DELETE eliminar participante del prode (admin) ───────────────────────────
// Borra pronósticos, puntos y el cupón prode. Deja al cliente en la BD.
router.delete('/participante/:clientId', auth, adminOnly, async (req, res) => {
  try {
    const { clientId } = req.params;
    const { Client } = require('../models/Order');
    const Coupon = require('../models/Coupon');

    // Buscar cupón prode antes de modificar el cliente
    const client = await Client.findById(clientId).select('prodeGuestCouponCode').lean();
    if (client?.prodeGuestCouponCode) {
      await Coupon.deleteOne({ code: client.prodeGuestCouponCode });
    }

    const [p, pts] = await Promise.all([
      Pronostico.deleteMany({ clientId }),
      ProdePoints.deleteMany({ clientId }),
      Client.findByIdAndUpdate(clientId, {
        $unset: { prodeRegisteredAt: '', prodeGuestCouponCode: '' },
      }),
    ]);

    res.json({
      pronosticosEliminados: p.deletedCount,
      puntosEliminados: pts.deletedCount,
      cuponEliminado: !!client?.prodeGuestCouponCode,
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

module.exports = router;