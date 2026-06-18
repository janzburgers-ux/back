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

// ── GET ranking público — top 20, sin auth ────────────────────────────────────
router.get('/ranking/publico', async (req, res) => {
  try {
    const ranking = await getRanking();
    // El orden ya viene aplicado desde getRanking() con las 4 reglas de desempate.
    // No re-sortear aquí para no pisar esas reglas.
    const top20 = ranking.slice(0, 20).map((r, i) => ({
      posicion:          i + 1,
      _id:               r.clientId,
      nombre:            r.apodo || r.nombre?.split(' ')[0] || r.nombre,
      totalPuntos:       r.totalPuntos,
      categoria:         r.categoriaLabel,
      elegibleTop3:      r.elegibleTop3,
      marcadoresExactos: r.marcadoresExactos || 0,
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

// ── POST re-evaluar FORZADO — resetea todos los pronósticos de partidos terminados
//    y recalcula puntos desde cero (útil para corregir errores históricos) ──────
router.post('/evaluar-forzado', auth, adminOnly, async (req, res) => {
  try {
    const matches = await ProdeMatch.find({ status: 'finished' });
    let reseteados = 0;
    let evaluados  = 0;

    for (const m of matches) {
      // 1) Borrar ProdePoints de pronósticos de este partido
      await ProdePoints.deleteMany({ matchId: m._id, tipo: 'pronostico' });
      // 2) Resetear flag en los pronósticos
      await Pronostico.updateMany(
        { matchId: m._id },
        { $set: { evaluated: false, pointsEarned: 0 } }
      );
      reseteados++;
      // 3) Re-evaluar con el resultado actual
      await evaluateMatch(m._id);
      evaluados++;
    }

    res.json({ reseteados, evaluados, message: `${evaluados} partidos re-evaluados desde cero` });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── GET diagnóstico profundo del ranking (solo admin) ────────────────────────
router.get('/ranking/diagnostico', auth, adminOnly, async (req, res) => {
  try {
    const { Client } = require('../models/Order');

    // 1. Cuantos ProdePoints hay en total?
    const totalPP = await ProdePoints.countDocuments();

    // 2. Como son los clientId en ProdePoints? ObjectId o String?
    const muestras = await ProdePoints.find({}).limit(5).select('clientId tipo puntos').lean();
    const tiposClientId = muestras.map(p => ({
      clientId: String(p.clientId),
      tipo_js: typeof p.clientId,
      es_objectid: p.clientId?.constructor?.name === 'ObjectId',
      tipo_prode: p.tipo,
      puntos: p.puntos,
    }));

    // 3. El aggregate inicial devuelve algo?
    const aggResult = await ProdePoints.aggregate([
      { $match: { tipo: { $in: ['pronostico', 'bonificacion'] }, clientId: { $exists: true, $ne: null } } },
      { $group: { _id: '$clientId', total: { $sum: '$puntos' } } },
    ]);

    // 4. Para cada clientId del aggregate, existe en la coleccion clients?
    const lookupTests = await Promise.all(aggResult.slice(0, 5).map(async r => {
      const byId = await Client.findById(r._id).select('name').lean();
      return {
        clientId: String(r._id),
        tipo_js: typeof r._id,
        es_objectid: r._id?.constructor?.name === 'ObjectId',
        totalPuntos: r.total,
        encontrado: !!byId,
        nombre: byId?.name || null,
      };
    }));

    // 5. Cuantos Pronosticos y con que clientIds?
    const totalPronos = await Pronostico.countDocuments();
    const pronoClientIds = await Pronostico.distinct('clientId');

    // 6. El aggregate completo con lookup devuelve algo?
    const aggConLookup = await ProdePoints.aggregate([
      { $match: { tipo: { $in: ['pronostico', 'bonificacion'] }, clientId: { $exists: true, $ne: null } } },
      { $group: { _id: '$clientId', total: { $sum: '$puntos' } } },
      { $lookup: { from: 'clients', localField: '_id', foreignField: '_id', as: 'client' } },
      { $addFields: { clientFound: { $gt: [{ $size: '$client' }, 0] } } },
    ]);
    const conCliente = aggConLookup.filter(r => r.clientFound).length;
    const sinCliente = aggConLookup.filter(r => !r.clientFound).length;

    res.json({
      resumen: {
        totalProdePoints: totalPP,
        totalPronosticos: totalPronos,
        clientIdsConPronosticos: pronoClientIds.length,
        aggSinLookup: aggResult.length,
        aggConLookup_conCliente: conCliente,
        aggConLookup_sinCliente: sinCliente,
        diagnostico: aggResult.length === 0
          ? 'SIN_DATOS: No hay ProdePoints en la BD. El ranking esta vacio porque nadie tiene puntos aun.'
          : conCliente === 0
            ? 'PROBLEMA_LOOKUP: El lookup no encuentra ningun cliente. clientId en ProdePoints no matchea con _id en clients.'
            : conCliente + ' clientes encontrados, ' + sinCliente + ' sin match en clients',
      },
      muestras_ProdePoints: tiposClientId,
      lookup_tests: lookupTests,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
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

// ── GET PDF de pronósticos de un cliente ──────────────────────────────────────
// Accesible con auth de cliente (token en cookie/header) o sin auth (link directo con clientId)
// ?download=1 → fuerza descarga (attachment), sin parámetro → abre en navegador (inline/imprimir)
router.get('/pdf/:clientId', async (req, res) => {
  try {
    const { generateProdePDF } = require('../services/prode-pdf.services');
    const pdfBuffer    = await generateProdePDF(req.params.clientId);
    const disposition  = req.query.download === '1'
      ? `attachment; filename="prode-janz-${req.params.clientId}.pdf"`
      : `inline; filename="prode-janz-${req.params.clientId}.pdf"`;
    res.set({
      'Content-Type':        'application/pdf',
      'Content-Disposition': disposition,
      'Content-Length':      pdfBuffer.length,
    });
    res.end(pdfBuffer);
  } catch (err) {
    console.error('[ProdePDF] Error:', err.message);
    res.status(500).json({ message: err.message });
  }
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

// ── GET preview destinatarios de notificación manual ─────────────────────────
// Devuelve la lista de participantes que recibirían el mensaje según el filtro,
// junto con un preview del mensaje de cada uno.
// Query params:
//   segmento  : 'todos' | 'invitado' | 'cliente' | 'competidor'  (default: todos)
//   periodo   : 'ultimas24h' | 'ultimas48h' | 'semana' | 'todo'  (default: ultimas24h)
//   soloConPuntos : '1' — solo los que tienen al menos 1 pto (default: 0)
router.get('/notificaciones/preview', auth, adminOnly, async (req, res) => {
  try {
    const { segmento = 'todos', periodo = 'ultimas24h', soloConPuntos = '0' } = req.query;

    // Calcular ventana temporal
    const ahora = Date.now();
    const ventanas = { ultimas24h: 24, ultimas48h: 48, semana: 168, todo: 0 };
    const horas = ventanas[periodo] ?? 24;
    const desde = horas > 0 ? new Date(ahora - horas * 3_600_000) : null;

    // Traer pronósticos evaluados en el período
    const filtroBase = { evaluated: true };
    if (desde) filtroBase.updatedAt = { $gte: desde };

    const pronosticos = await Pronostico.find(filtroBase).populate('matchId').lean();

    // Agrupar por cliente
    const byClient = {};
    for (const p of pronosticos) {
      const cid = String(p.clientId);
      if (!byClient[cid]) byClient[cid] = [];
      byClient[cid].push(p);
    }

    // Si periodo=todo, incluir también participantes sin pronósticos evaluados
    // (para mensajes de tipo "recordatorio")
    if (!desde) {
      const allClientIds = await Pronostico.distinct('clientId');
      for (const cid of allClientIds) {
        if (!byClient[String(cid)]) byClient[String(cid)] = [];
      }
    }

    const { Client } = require('../models/Order');
    const { buildDailyProdeMessage: buildMsg } = require('../jobs/prode-notifications');
    const { getRanking } = require('../services/prode.service');
    const cfg = await getProdeConfig();

    // PERF FIX: este endpoint tenía el mismo problema que tenía antes
    // /prode/ranking — resolvía cada participante de forma SECUENCIAL
    // (resolveProdeStatus + Client.findById, uno atrás del otro). Con varios
    // participantes esto superaba el timeout de 10s del frontend, el preview
    // nunca cargaba, y por eso el botón "Enviar" no aparecía nunca (solo se
    // muestra cuando el preview cargó bien). Ahora se resuelven todos los
    // participantes EN PARALELO y se trae a todos los clientes en una sola
    // consulta en vez de una por participante.
    const clientIdsList = Object.keys(byClient);
    const clientsDocs = await Client.find({ _id: { $in: clientIdsList } })
      .select('name whatsapp phone').lean();
    const clientMap = {};
    clientsDocs.forEach(c => { clientMap[String(c._id)] = c; });

    // Cargar ranking una sola vez para el preview (igual que en el job de notificaciones)
    let rankingMap = {};
    try {
      const ranking = await getRanking();
      ranking.forEach((r, i) => { rankingMap[String(r.clientId || r._id)] = i + 1; });
    } catch (e) {
      console.error('[preview] No se pudo cargar el ranking:', e.message);
    }

    const resultados = await Promise.all(
      Object.entries(byClient).map(async ([clientId, prons]) => {
        const status = await resolveProdeStatus(clientId, cfg);
        if (!status) return null;

        // Filtrar por segmento
        if (segmento !== 'todos') {
          const seg = status.premioSegmento; // 'invitado' | 'cliente' | 'competidor'
          if (segmento === 'invitado'    && seg !== 'invitado')    return null;
          if (segmento === 'cliente'     && seg !== 'cliente')     return null;
          if (segmento === 'competidor'  && seg !== 'competidor')  return null;
        }

        // Filtrar solo con puntos
        if (soloConPuntos === '1' && status.totalPuntos === 0) return null;

        const client = clientMap[String(clientId)];
        if (!client) return null;
        const waNum = client.whatsapp || client.phone || '';

        // Construir preview del mensaje con ranking incluido
        const rankingPos = rankingMap[String(clientId)] || null;
        const msg = buildMsg(status, prons, cfg, rankingPos);

        return {
          clientId,
          nombre:    client.name,
          whatsapp:  waNum,
          segmento:  status.premioSegmento,
          categoria: status.categoriaLabel,
          puntos:    status.totalPuntos,
          partidos:  prons.length,
          sinWa:     !waNum,
          msgPreview: msg,
        };
      })
    );

    const destinatarios = resultados.filter(Boolean);

    // Ordenar: primero los que tienen WA, luego por puntos desc
    destinatarios.sort((a, b) => {
      if (a.sinWa !== b.sinWa) return a.sinWa ? 1 : -1;
      return b.puntos - a.puntos;
    });

    res.json({
      total:       destinatarios.length,
      conWa:       destinatarios.filter(d => !d.sinWa).length,
      sinWa:       destinatarios.filter(d => d.sinWa).length,
      destinatarios,
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── POST enviar mensajes de notificación manual ───────────────────────────────
// Body JSON:
//   segmento      : 'todos' | 'invitado' | 'cliente' | 'competidor'
//   periodo       : 'ultimas24h' | 'ultimas48h' | 'semana' | 'todo'
//   soloConPuntos : boolean
//   mensajeCustom : string | null  — si viene, reemplaza el template automático
//   clientIds     : string[] | null — si viene, envía SOLO a esos ids (ignore filtros)
router.post('/notificaciones/enviar', auth, adminOnly, async (req, res) => {
  try {
    const {
      segmento      = 'todos',
      periodo       = 'ultimas24h',
      soloConPuntos = false,
      mensajeCustom = null,
      clientIds     = null,
    } = req.body;

    const { buildDailyProdeMessage } = require('../jobs/prode-notifications');
    const { sendMessage } = require('../services/whatsapp');
    const { Client } = require('../models/Order');
    const cfg = await getProdeConfig();

    // ── Armar lista de destinatarios ─────────────────────────────────────────
    let targetIds;

    if (Array.isArray(clientIds) && clientIds.length > 0) {
      // Envío selectivo (admin marcó participantes específicos)
      targetIds = clientIds;
    } else {
      // Envío por segmento/período
      const ahora = Date.now();
      const ventanas = { ultimas24h: 24, ultimas48h: 48, semana: 168, todo: 0 };
      const horas = ventanas[periodo] ?? 24;
      const desde = horas > 0 ? new Date(ahora - horas * 3_600_000) : null;

      const filtroBase = { evaluated: true };
      if (desde) filtroBase.updatedAt = { $gte: desde };

      const pronosticos = await Pronostico.find(filtroBase).lean();

      // Si período=todo, incluir todos los participantes aunque no tengan prons evaluados
      let allIds = [...new Set(pronosticos.map(p => String(p.clientId)))];
      if (!desde) {
        const todos = await Pronostico.distinct('clientId');
        allIds = [...new Set([...allIds, ...todos.map(String)])];
      }
      targetIds = allIds;
    }

    const results = { sent: 0, skipped: 0, errors: 0, detalle: [] };

    for (const clientId of targetIds) {
      try {
        const status = await resolveProdeStatus(clientId);
        if (!status) { results.skipped++; continue; }

        // Filtrar por segmento (solo si no es envío selectivo)
        if (!Array.isArray(clientIds)) {
          const seg = status.premioSegmento;
          if (segmento !== 'todos') {
            if (segmento === 'invitado'   && seg !== 'invitado')   { results.skipped++; continue; }
            if (segmento === 'cliente'    && seg !== 'cliente')     { results.skipped++; continue; }
            if (segmento === 'competidor' && seg !== 'competidor')  { results.skipped++; continue; }
          }
          if (soloConPuntos && status.totalPuntos === 0)            { results.skipped++; continue; }
        }

        const client = await Client.findById(clientId).select('name whatsapp phone').lean();
        const waNum  = client?.whatsapp || client?.phone || '';

        if (!waNum) {
          results.skipped++;
          results.detalle.push({ nombre: client?.name || clientId, estado: 'sin_wa' });
          continue;
        }

        // Construir mensaje
        let msg;
        if (mensajeCustom?.trim()) {
          // Reemplazar placeholder {{nombre}} si el admin lo usó
          msg = mensajeCustom.replace(/\{\{nombre\}\}/g, status.nombre);
        } else {
          // Usar el período completo del prode para armar el resumen
          const prons = await Pronostico.find({ clientId, evaluated: true })
            .populate('matchId').lean();
          msg = buildDailyProdeMessage(status, prons, cfg);
        }

        await sendMessage(waNum, msg);
        results.sent++;
        results.detalle.push({ nombre: client.name, estado: 'enviado', waNum });

        // Pausa anti-spam
        await new Promise(r => setTimeout(r, 1200));

      } catch (e) {
        console.error(`❌ [ProdeNotif Manual] Error con ${clientId}:`, e.message);
        results.errors++;
        results.detalle.push({ nombre: clientId, estado: 'error', error: e.message });
      }
    }

    console.log(`📲 [ProdeNotif Manual] Fin: ${results.sent} enviados, ${results.skipped} saltados, ${results.errors} errores`);
    res.json(results);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── Cache liviano del ranking (evita recalcular en cada request) ──────────────
let _rankingCache     = null;
let _rankingCacheAt   = 0;
const RANKING_CACHE_MS = 5 * 60 * 1000; // 5 minutos

async function getCachedRanking() {
  if (_rankingCache && Date.now() - _rankingCacheAt < RANKING_CACHE_MS) {
    return _rankingCache;
  }
  _rankingCache   = await getRanking();
  _rankingCacheAt = Date.now();
  return _rankingCache;
}

// ── GET predicciones públicas de un partido (sin auth) ────────────────────────
// Se revelan 5 minutos después del inicio del partido para que nadie copie
// las predicciones del top 10 antes de que arranque.
router.get('/predicciones-publicas/:matchId', async (req, res) => {
  try {
    const match = await ProdeMatch.findById(req.params.matchId).lean();
    if (!match) return res.status(404).json({ message: 'Partido no encontrado' });

    const REVEAL_MS = 5 * 60 * 1000;
    const revealAt  = new Date(match.matchDate.getTime() + REVEAL_MS);
    const revealed  = Date.now() >= revealAt.getTime();

    const matchPublic = {
      homeTeam:  match.homeTeam,
      awayTeam:  match.awayTeam,
      homeLogo:  match.homeLogo,
      awayLogo:  match.awayLogo,
      matchDate: match.matchDate,
      stage:     match.stage,
      status:    match.status,
      homeScore: match.homeScore,
      awayScore: match.awayScore,
      winner:    match.winner,
    };

    if (!revealed) {
      return res.json({ revealed: false, revealAt, match: matchPublic });
    }

    // Top 10 del ranking (cacheado 5 min para no recalcular en cada request)
    const ranking = await getCachedRanking();
    const top10   = ranking.slice(0, 10);

    // Sus predicciones para este partido en una sola query
    const clientIds   = top10.map(r => r.clientId);
    const pronosticos = await Pronostico.find({
      matchId:  match._id,
      clientId: { $in: clientIds },
    }).lean();

    const pronoByClient = {};
    for (const p of pronosticos) {
      pronoByClient[String(p.clientId)] = p;
    }

    const predicciones = top10.map((r, i) => {
      const p = pronoByClient[String(r.clientId)];
      return {
        position:    i + 1,
        apodo:       r.apodo,        // solo primer nombre, sin datos de contacto
        totalPuntos: r.totalPuntos,
        prediccion:  p ? {
          winner: p.predictedWinner,
          home:   p.predictedHome,   // null si no ingresó marcador
          away:   p.predictedAway,
        } : null,                    // null = no pronosticó este partido
      };
    });

    res.json({ revealed: true, match: matchPublic, predicciones });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;