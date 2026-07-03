const axios = require('axios');
const mongoose = require('mongoose');
const { ProdeMatch, Pronostico, ProdePoints, ProdeConfig } = require('../models/Prode');
const { Client, Order } = require('../models/Order');
const { sendMessage } = require('./whatsapp');

// ── Subtipos de bonificación (idempotencia) ───────────────────────────────────
const BONUS = {
  UPGRADE_CLIENTE: 'upgrade_cliente',
  UPGRADE_VIP:     'upgrade_vip',
};

const FOOTBALL_DATA_BASE = 'https://api.football-data.org/v4';

function mapStage(stage = '') {
  const map = {
    GROUP_STAGE:    'Fase de Grupos',
    ROUND_OF_32:    'Ronda de 32',
    ROUND_OF_16:    'Octavos de Final',
    QUARTER_FINALS: 'Cuartos de Final',
    SEMI_FINALS:    'Semifinal',
    THIRD_PLACE:    'Tercer Puesto',
    FINAL:          'Final',
  };
  return map[stage] || stage;
}

function mapGroup(group = '') {
  return group ? group.replace('GROUP_', 'Grupo ') : '';
}

const LIVE_STATUSES     = ['IN_PLAY', 'PAUSED', 'HALFTIME', 'EXTRA_TIME', 'PENALTY_SHOOTOUT'];
const FINISHED_STATUSES = ['FINISHED', 'FINISHED_AET', 'FINISHED_AP'];
// Statuses especiales: no resetear scores ya guardados
const AWARDED_STATUSES  = ['AWARDED', 'POSTPONED', 'SUSPENDED', 'CANCELLED'];

function mapWinner(winner) {
  if (winner === 'HOME_TEAM') return 'home';
  if (winner === 'AWAY_TEAM') return 'away';
  if (winner === 'DRAW')      return 'draw';
  return null;
}

function normalizePhone(raw = '') {
  return String(raw).replace(/\D/g, '');
}

function phoneKey(raw = '') {
  const clean = normalizePhone(raw);
  return clean.slice(-8);
}

async function findClientByPhone(raw = '') {
  const key = phoneKey(raw);
  if (!key) return null;
  return Client.findOne({
    $or: [
      { whatsapp: { $regex: key } },
      { phone:    { $regex: key } },
    ],
    active: true,
  });
}

function buildDeliveredPeriodFilter(clientId, cfg) {
  const filter = { client: clientId, status: 'delivered' };
  if (cfg.startDate) {
    filter.deliveredAt = { $gte: new Date(cfg.startDate) };
  }
  if (cfg.endDate) {
    filter.deliveredAt = {
      ...(filter.deliveredAt || {}),
      $lte: new Date(cfg.endDate),
    };
  }
  return filter;
}

async function countDeliveredPreProde(clientId, cfg) {
  if (!cfg.startDate) return 0;
  return Order.countDocuments({
    client: clientId,
    status: 'delivered',
    deliveredAt: { $lt: new Date(cfg.startDate) },
  });
}

async function countDeliveredInPeriod(clientId, cfg) {
  if (!cfg.startDate) return 0;
  return Order.countDocuments(buildDeliveredPeriodFilter(clientId, cfg));
}

// ── Obtener config activa ─────────────────────────────────────────────────────
async function getProdeConfig() {
  let cfg = await ProdeConfig.findOne({ key: 'prode' });
  if (!cfg) {
    cfg = await ProdeConfig.create({ key: 'prode', value: {} });
  }
  return cfg.value;
}

async function isProdeActive() {
  const cfg = await getProdeConfig();
  if (!cfg.enabled) return false;
  const now = new Date();
  if (cfg.startDate && now < new Date(cfg.startDate)) return false;
  if (cfg.endDate   && now > new Date(cfg.endDate))   return false;
  return true;
}

async function isOrderInProdePeriod(deliveredAt, cfg) {
  if (!cfg.startDate) return false;
  const d = new Date(deliveredAt);
  if (d < new Date(cfg.startDate)) return false;
  if (cfg.endDate && d > new Date(cfg.endDate)) return false;
  return true;
}

// ── Sync fixture ────────────────────────────────────────────────────────────────
async function syncFixture() {
  const FOOTBALL_DATA_KEY = process.env.FOOTBALL_DATA_KEY;

  if (!FOOTBALL_DATA_KEY) {
    return { synced: 0, error: 'FOOTBALL_DATA_KEY no definida en variables de entorno. Registrate en football-data.org y agregala en Railway.' };
  }

  try {
    const { data } = await axios.get(`${FOOTBALL_DATA_BASE}/competitions/WC/matches`, {
      headers: { 'X-Auth-Token': FOOTBALL_DATA_KEY },
      params: { limit: 500 }, // el Mundial 2026 tiene 104 partidos; la API trunca a 100 por defecto
      timeout: 15000,
    });

    const matches = data?.matches || [];
    if (!Array.isArray(matches) || matches.length === 0) {
      return { synced: 0, error: 'La API devolvio 0 partidos. Verificar que el Mundial 2026 este disponible en tu plan.' };
    }

    // Traemos el estado actual de cada partido para poder decidir, por partido,
    // si un resultado "finished" es nuevo/distinto (→ queda pendiente de
    // confirmación) o si ya estaba confirmado igual (→ no tocar nada).
    const existingDocs = await ProdeMatch.find(
      {},
      'apiId status homeScore awayScore winner pendingReview pendingHomeScore pendingAwayScore'
    ).lean();
    const existingByApiId = new Map(existingDocs.map(d => [d.apiId, d]));

    const ops = matches.map(m => {
      const apiId     = String(m.id);
      const homeTeam  = m.homeTeam?.name || 'TBD';
      const awayTeam  = m.awayTeam?.name || 'TBD';
      const homeLogo  = m.homeTeam?.crest || '';
      const awayLogo  = m.awayTeam?.crest || '';
      const matchDate = m.utcDate ? new Date(m.utcDate) : null;
      const stage     = mapStage(m.stage || '');
      const group     = mapGroup(m.group || '');

      const isTBD = (name) =>
        !name ||
        name === 'TBD' ||
        /^(winner|loser|ganador|perdedor)\b/i.test(name) ||
        /^(w|l)\s?(of|del?)\s/i.test(name);
      const teamsConfirmed = !isTBD(homeTeam) && !isTBD(awayTeam);

      // Declarado ANTES de los bloques if/else if que lo usan (evita
      // ReferenceError por TDZ: antes estaba más abajo y se referenciaba
      // dentro del bloque 'finished' antes de inicializarse).
      const $setFields = {
        homeTeam, awayTeam, homeLogo, awayLogo, matchDate, stage, group,
        teamsConfirmed,
      };

      let status    = 'scheduled';
      let homeScore = null;
      let awayScore = null;
      let winner    = null;

      if (FINISHED_STATUSES.includes(m.status)) {
        status = 'finished';
        const rt = m.score?.regularTime;
        const ft = m.score?.fullTime;
        const et = m.score?.extraTime;
        const pk = m.score?.penalties;

        // Prioridad: regularTime (90' exactos en eliminatorias) > fullTime (siempre presente)
        // Verificar explícitamente !== null porque la API puede mandar { home: null, away: null }
        const rtHome = (rt?.home !== null && rt?.home !== undefined) ? rt.home : null;
        const rtAway = (rt?.away !== null && rt?.away !== undefined) ? rt.away : null;
        const ftHome = (ft?.home !== null && ft?.home !== undefined) ? ft.home : null;
        const ftAway = (ft?.away !== null && ft?.away !== undefined) ? ft.away : null;

        homeScore = rtHome ?? ftHome ?? null;
        awayScore = rtAway ?? ftAway ?? null;

        if (homeScore === null || awayScore === null) {
          console.warn(`⚠️ [ProdeSync] ${m.homeTeam?.name} vs ${m.awayTeam?.name} | apiStatus=${m.status} | score crudo:`, JSON.stringify(m.score));
        }

        // winner siempre derivado de los 90' (m.score.winner refleja al clasificado, puede diferir)
        if (homeScore !== null && awayScore !== null) {
          winner = homeScore > awayScore ? 'home'
                 : awayScore > homeScore ? 'away'
                 : 'draw';
        }

        const wentToET   = !!(et?.home !== null && et?.home !== undefined);
        const wentToPens = !!(pk?.home !== null && pk?.home !== undefined);
        $setFields.wentToET      = wentToET;
        $setFields.wentToPens    = wentToPens;
        $setFields.extraTimeHome = et?.home ?? null;
        $setFields.extraTimeAway = et?.away ?? null;
        $setFields.penaltiesHome = pk?.home ?? null;
        $setFields.penaltiesAway = pk?.away ?? null;
        $setFields.qualifiedTeam = mapWinner(m.score?.winner) !== 'draw'
          ? (mapWinner(m.score?.winner) === 'home' ? m.homeTeam : m.awayTeam)
          : null;

      } else if (LIVE_STATUSES.includes(m.status)) {
        status = 'live';
        const ft = m.score?.fullTime;
        const rt = m.score?.regularTime;
        homeScore = (rt?.home !== null && rt?.home !== undefined) ? rt.home
                  : (ft?.home !== null && ft?.home !== undefined) ? ft.home : null;
        awayScore = (rt?.away !== null && rt?.away !== undefined) ? rt.away
                  : (ft?.away !== null && ft?.away !== undefined) ? ft.away : null;

      } else if (AWARDED_STATUSES.includes(m.status)) {
        // Partido aplazado/suspendido: no tocar status ni scores ya guardados
        console.warn(`⚠️ [ProdeSync] Status especial ignorado: ${m.status} | ${m.homeTeam?.name} vs ${m.awayTeam?.name}`);
        return {
          updateOne: {
            filter: { apiId },
            update: { $set: { homeTeam, awayTeam, homeLogo, awayLogo, matchDate, stage, group, teamsConfirmed } },
            upsert: true,
          },
        };
      }

      const existing = existingByApiId.get(apiId);

      if (status === 'finished') {
        const yaConfirmadoIgual =
          existing?.status === 'finished' &&
          existing?.homeScore === homeScore &&
          existing?.awayScore === awayScore;

        if (yaConfirmadoIgual) {
          // Ya está cargado y confirmado con este mismo resultado: no tocar nada
          // (ni status, ni scores, ni flags de pendiente).
        } else {
          // Resultado nuevo o distinto al confirmado: queda EN REVISIÓN.
          // No se pisan homeScore/awayScore/winner/status reales — el admin
          // tiene que confirmarlo (o corregirlo) a mano desde el panel antes
          // de que se evalúen los pronósticos y se repartan puntos.
          // Nota: esto cubre tanto un partido recién terminado como una corrección
          // tardía de la fuente sobre un partido que ya estaba confirmado.
          $setFields.status           = 'pending_review';
          $setFields.pendingReview    = true;
          $setFields.pendingHomeScore = homeScore;
          $setFields.pendingAwayScore = awayScore;
          $setFields.pendingWinner    = winner;
          const yaEstabaPendienteIgual =
            existing?.pendingReview &&
            existing?.pendingHomeScore === homeScore &&
            existing?.pendingAwayScore === awayScore;
          if (!yaEstabaPendienteIgual) $setFields.pendingSince = new Date();
        }
      } else if (status === 'live') {
        $setFields.status = 'live';
        if (homeScore !== null) $setFields.homeScore = homeScore;
        if (awayScore !== null) $setFields.awayScore = awayScore;
        if (winner    !== null) $setFields.winner    = winner;
      } else {
        // scheduled: el partido no ocurrió aún, limpiar scores
        $setFields.status        = 'scheduled';
        $setFields.homeScore     = null;
        $setFields.awayScore     = null;
        $setFields.winner        = null;
        $setFields.extraTimeHome = null;
        $setFields.extraTimeAway = null;
        $setFields.penaltiesHome = null;
        $setFields.penaltiesAway = null;
        $setFields.wentToET      = false;
        $setFields.wentToPens    = false;
        $setFields.qualifiedTeam = null;
        $setFields.pendingReview    = false;
        $setFields.pendingHomeScore = null;
        $setFields.pendingAwayScore = null;
        $setFields.pendingWinner    = null;
        $setFields.pendingSince     = null;
      }

      return {
        updateOne: {
          filter: { apiId },
          update: { $set: $setFields },
          upsert: true,
        },
      };
    });

    const result = await ProdeMatch.bulkWrite(ops, { ordered: false });
    const synced = result.upsertedCount + result.modifiedCount + result.matchedCount;

    console.log(`Prode: ${synced} partidos sincronizados desde football-data.org (WC 2026)`);
    return { synced: matches.length, insertados: result.upsertedCount, actualizados: result.modifiedCount };
  } catch (err) {
    console.error('Prode sync error:', err.message);
    const status = err.response?.status;
    if (status === 403) return { synced: 0, error: 'API key invalida o sin permisos. Verificar FOOTBALL_DATA_KEY.' };
    if (status === 429) return { synced: 0, error: 'Rate limit alcanzado (10 req/min). Espera un momento y reintenta.' };
    if (status === 404) return { synced: 0, error: 'Competicion WC no encontrada. Puede que el Mundial 2026 aun no este en el sistema.' };
    return { synced: 0, error: err.message };
  }
}

async function seedMockFixture() {
  const existing = await ProdeMatch.countDocuments();
  if (existing > 0) return;

  const groups = ['A','B','C','D','E','F','G','H'];
  const teams = {
    A: ['Argentina','Canadá','Marruecos','Kenia'],
    B: ['España','Brasil','Japón','Argelia'],
    C: ['Francia','Alemania','México','Ecuador'],
    D: ['Inglaterra','Portugal','Colombia','Arabia Saudita'],
    E: ['Países Bajos','Italia','Uruguay','Senegal'],
    F: ['Estados Unidos','Bélgica','Perú','Camerún'],
    G: ['Croacia','Chile','Nigeria','Irán'],
    H: ['Suiza','Dinamarca','Australia','Costa Rica'],
  };

  const baseDate = new Date('2026-06-11T20:00:00-03:00');
  let matchIndex = 0;
  const matches = [];

  for (const g of groups) {
    const t = teams[g];
    const pairs = [[0,1],[2,3],[0,2],[1,3],[0,3],[1,2]];
    for (const [i, j] of pairs) {
      const d = new Date(baseDate);
      d.setDate(d.getDate() + matchIndex % 12);
      matches.push({
        apiId: `mock-group-${g}-${i}-${j}`,
        stage: 'Fase de Grupos',
        group: `Grupo ${g}`,
        homeTeam: t[i],
        awayTeam: t[j],
        matchDate: d,
        status: 'scheduled',
        teamsConfirmed: true,
      });
      matchIndex++;
    }
  }

  await ProdeMatch.insertMany(matches);
  console.log(`🌱 Prode: ${matches.length} partidos mockeados insertados`);
}

// ── Bonus helpers ─────────────────────────────────────────────────────────────
async function grantBonus(clientId, { subtipo, puntos, descripcion, orderId = null }) {
  const existing = await ProdePoints.findOne({ clientId, subtipo });
  if (existing) return null;

  const record = await ProdePoints.create({
    clientId,
    orderId,
    tipo: 'bonificacion',
    subtipo,
    descripcion,
    puntos,
  });

  return record;
}

function resolveCategoria(entregasPreProde, entregasEnPeriodo) {
  if (entregasEnPeriodo >= 2) return 'vip';
  if (entregasPreProde >= 1 || entregasEnPeriodo >= 1) return 'cliente';
  return 'invitado';
}

function resolvePremioSegmento(entregasPreProde, entregasEnPeriodo) {
  if (entregasEnPeriodo >= 1) return 'competidor';
  if (entregasPreProde >= 1) return 'cliente';
  return 'invitado';
}

function premioDescripcion(segmento, cfg = {}) {
  if (segmento === 'competidor') return 'Competís por los premios top 3 del ranking';
  if (segmento === 'cliente')    return cfg.prizeCliente || 'Combo doble a elección';
  return cfg.prizeInvitado || 'Cupón 20% en tu primera compra';
}

function buildProximoPaso(categoria, entregasPreProde, entregasEnPeriodo, cfg = {}) {
  const faltaVip = Math.max(0, 2 - entregasEnPeriodo);

  if (categoria === 'invitado') {
    return 'Hacé tu primera compra entregada: pasás a Cliente y sumás +3 pts';
  }
  if (categoria === 'cliente' && faltaVip > 0) {
    if (entregasPreProde >= 1 && entregasEnPeriodo === 0) {
      return 'Comprá durante el Mundial para competir por el podio (+3 pts al llegar a VIP con 2 entregas)';
    }
    return faltaVip === 1
      ? '1 entrega más en el período → VIP (+3 pts) y competís por el podio'
      : `${faltaVip} entregas más en el período → VIP (+3 pts)`;
  }
  if (categoria === 'vip') {
    return 'Sos VIP: competís por los premios top 3. ¡Seguí pronosticando!';
  }
  if (entregasEnPeriodo >= 1) {
    return 'Competís por el podio. Seguí pronosticando para escalar posiciones.';
  }
  return cfg.prizeCliente ? `Premio Cliente: ${cfg.prizeCliente}` : '';
}

// ── Estado del participante ─────────────────────────────────────────────────────
async function resolveProdeStatus(clientId, cfgPreloaded = null) {
  const cfg = cfgPreloaded || await getProdeConfig();
  const client = await Client.findById(clientId).select('name prodeRegisteredAt prodeGuestCouponCode').lean();
  if (!client) return null;

  const entregasPreProde  = await countDeliveredPreProde(clientId, cfg);
  const entregasEnPeriodo = await countDeliveredInPeriod(clientId, cfg);
  const categoria         = resolveCategoria(entregasPreProde, entregasEnPeriodo);
  const premioSegmento    = resolvePremioSegmento(entregasPreProde, entregasEnPeriodo);
  const elegibleTop3      = entregasEnPeriodo >= 1;
  const faltaParaVip      = Math.max(0, 2 - entregasEnPeriodo);

  const bonuses = await ProdePoints.find({
    clientId,
    tipo: 'bonificacion',
    subtipo: { $in: [BONUS.UPGRADE_CLIENTE, BONUS.UPGRADE_VIP] },
  }).select('subtipo puntos').lean();

  const bonusMap = {};
  bonuses.forEach(b => { bonusMap[b.subtipo] = b.puntos; });

  const puntosBonus = bonuses.reduce((s, b) => s + b.puntos, 0);
  const totalPts    = await getTotalPoints(clientId);

  return {
    clientId,
    nombre: client.name?.split(' ')[0] || 'Participante',
    categoria,
    categoriaLabel: categoria === 'vip' ? 'VIP' : categoria === 'cliente' ? 'Cliente' : 'Invitado',
    premioSegmento,
    premioDescripcion: premioDescripcion(premioSegmento, cfg),
    elegibleTop3,
    entregasPreProde,
    entregasEnPeriodo,
    faltaParaVip,
    proximoPaso: buildProximoPaso(categoria, entregasPreProde, entregasEnPeriodo, cfg),
    bonusUpgradeCliente: bonusMap[BONUS.UPGRADE_CLIENTE] || 0,
    bonusUpgradeVip:     bonusMap[BONUS.UPGRADE_VIP] || 0,
    puntosBonus,
    totalPuntos: totalPts,
    cuponInvitado: client.prodeGuestCouponCode || null,
    prodeRegisteredAt: client.prodeRegisteredAt || null,
  };
}

// ── Procesar categoría al ENTREGAR pedido ───────────────────────────────────────
async function processProdeCategoryOnDelivery(clientId, orderId) {
  const cfg = await getProdeConfig();
  if (!cfg.enabled) return null;

  const order = await Order.findById(orderId).select('status deliveredAt client');
  if (!order || order.status !== 'delivered') return null;

  const deliveredAt = order.deliveredAt || new Date();
  if (!await isOrderInProdePeriod(deliveredAt, cfg)) return null;

  const entregasPreProde  = await countDeliveredPreProde(clientId, cfg);
  const entregasEnPeriodo = await countDeliveredInPeriod(clientId, cfg);

  const granted = [];

  // Invitado → Cliente: 1.ª entrega en período sin historial pre-Prode
  if (entregasEnPeriodo === 1 && entregasPreProde === 0) {
    const r = await grantBonus(clientId, {
      subtipo: BONUS.UPGRADE_CLIENTE,
      puntos: cfg.pointsCategoryCliente || 3,
      descripcion: 'Primera compra entregada — pasás a Cliente (+3 pts)',
      orderId,
    });
    if (r) granted.push(BONUS.UPGRADE_CLIENTE);
  }

  // → VIP: 2.ª entrega en período
  if (entregasEnPeriodo === 2) {
    const r = await grantBonus(clientId, {
      subtipo: BONUS.UPGRADE_VIP,
      puntos: cfg.pointsCategoryVip || 3,
      descripcion: '2 compras entregadas en el Mundial — sos VIP (+3 pts)',
      orderId,
    });
    if (r) granted.push(BONUS.UPGRADE_VIP);
  }

  if (granted.length === 0) return { entregasEnPeriodo, entregasPreProde, granted: [] };

  try {
    const client = await Client.findById(clientId);
    if (client?.whatsapp) {
      const status = await resolveProdeStatus(clientId);
      const bonusTxt = granted.includes(BONUS.UPGRADE_VIP)
        ? '🌟 *¡Ahora sos VIP!* Sumaste +3 pts extra.'
        : '🎉 *¡Pasaste a Cliente!* Sumaste +3 pts extra.';
      const msg =
        `🏆 *Prode Janz — Actualización*\n\n` +
        `${bonusTxt}\n\n` +
        `Tu total: *${status.totalPuntos} pts*\n` +
        `Categoría: *${status.categoriaLabel}*\n\n` +
        `${status.proximoPaso}\n\n` +
        `_Janz Burgers_ 🍔⚽`;
      sendMessage(client.whatsapp, msg).catch(e => console.error('WA prode category:', e.message));
    }
  } catch (e) {
    console.error('WA prode category notify:', e.message);
  }

  return { entregasEnPeriodo, entregasPreProde, granted };
}

// ── Registro invitado ───────────────────────────────────────────────────────────
function generateProdeCouponCode(name = 'INV') {
  const prefix = String(name).replace(/[^a-zA-Z0-9]/g, '').slice(0, 4).toUpperCase() || 'INV';
  const suffix = String(Math.floor(1000 + Math.random() * 9000));
  return `PRODE${prefix}${suffix}`;
}

async function createGuestCoupon(client, cfg) {
  if (client.prodeGuestCouponCode) {
    return client.prodeGuestCouponCode;
  }

  const entregasPre = await countDeliveredPreProde(client._id, cfg);
  if (entregasPre > 0) return null;

  const Coupon = require('../models/Coupon');
  let code = generateProdeCouponCode(client.name);
  for (let i = 0; i < 5; i++) {
    const exists = await Coupon.findOne({ code });
    if (!exists) break;
    code = generateProdeCouponCode(client.name);
  }

  await Coupon.create({
    code,
    owner: client._id,
    ownerName: client.name,
    type: 'admin',
    discountForUser: cfg.guestCouponPercent || 20,
    singleUse: true,
    unlimited: false,
    active: true,
    expiresAt: cfg.endDate ? new Date(cfg.endDate) : null,
  });

  await Client.findByIdAndUpdate(client._id, { prodeGuestCouponCode: code });
  return code;
}

async function registerProdeGuest({ nombre, whatsapp }) {
  const clean = normalizePhone(whatsapp);
  if (!nombre?.trim() || clean.length < 8) {
    throw new Error('Nombre y WhatsApp válido son requeridos');
  }

  const cfg = await getProdeConfig();
  if (!cfg.enabled) throw new Error('El Prode no está activo');

  let client = await findClientByPhone(clean);
  if (!client) {
    client = await Client.create({
      name: nombre.trim(),
      whatsapp: clean,
      phone: clean,
      prodeRegisteredAt: new Date(),
    });
  } else {
    if (!client.prodeRegisteredAt) {
      client.prodeRegisteredAt = new Date();
      await client.save();
    }
  }

  const couponCode = await createGuestCoupon(client, cfg);

  return { client, couponCode };
}

async function markProdeRegistered(clientId) {
  const client = await Client.findById(clientId);
  if (!client) return;
  if (!client.prodeRegisteredAt) {
    client.prodeRegisteredAt = new Date();
    await client.save();
  }
  const cfg = await getProdeConfig();
  await createGuestCoupon(client, cfg);
}

// ── Evaluar pronósticos ─────────────────────────────────────────────────────────
async function evaluateMatch(matchId) {
  const match = await ProdeMatch.findById(matchId);
  if (!match || match.status !== 'finished' || match.winner === null) return;

  const cfg = await getProdeConfig();
  const pronosticos = await Pronostico.find({ matchId, evaluated: false });

  for (const p of pronosticos) {
    let pts = 0;
    if (p.predictedWinner === match.winner) {
      pts += cfg.pointsWinner || 3;
      // FIX: usar Number() para comparación robusta (evita fallos por tipo String vs Number)
      if (
        p.predictedHome !== null &&
        p.predictedAway !== null &&
        Number(p.predictedHome) === Number(match.homeScore) &&
        Number(p.predictedAway) === Number(match.awayScore)
      ) {
        pts += cfg.pointsExact || 3;
      }
    }

    p.pointsEarned = pts;
    p.evaluated = true;
    await p.save();

    if (pts > 0) {
      // Upsert idempotente: evita E11000 si dos runs concurrentes procesan el mismo partido
      try {
        await ProdePoints.updateOne(
          { clientId: p.clientId, matchId, tipo: 'pronostico' },
          {
            $set: {
              puntos:      pts,
              descripcion: `${match.homeTeam} vs ${match.awayTeam} — ${pts} pts`,
            },
            $setOnInsert: {
              clientId: p.clientId,
              matchId,
              tipo: 'pronostico',
            },
          },
          { upsert: true }
        );
      } catch (dupErr) {
        if (dupErr.code !== 11000) throw dupErr;
        // E11000 en upsert concurrente: el registro ya existe, no es error real
      }
    } else {
      // FIX: si pts=0 (re-evaluación con resultado corregido), eliminar puntos anteriores
      // para que no queden puntos fantasma de una evaluación previa incorrecta
      await ProdePoints.deleteOne({ clientId: p.clientId, matchId, tipo: 'pronostico' });
    }
  }

  console.log(`✅ Evaluados ${pronosticos.length} pronósticos para ${match.homeTeam} vs ${match.awayTeam}`);
}

async function getTotalPoints(clientId) {
  if (!clientId) return 0;
  try {
    const result = await ProdePoints.aggregate([
      { $match: {
        clientId: new mongoose.Types.ObjectId(String(clientId)),
        tipo: { $in: ['pronostico', 'bonificacion'] },
      }},
      { $group: { _id: null, total: { $sum: '$puntos' } } },
    ]);
    return result[0]?.total || 0;
  } catch (e) {
    console.error('⚠️ getTotalPoints error para clientId', clientId, ':', e.message);
    return 0;
  }
}

// ── Ranking general ─────────────────────────────────────────────────────────────
async function getRanking() {
  const cfg = await getProdeConfig();

  // ── Aggregate principal: puntos + fecha del primer punto (criterio 4) ──────
  const ranking = await ProdePoints.aggregate([
    { $match: {
      tipo: { $in: ['pronostico', 'bonificacion'] },
      clientId: { $exists: true, $ne: null },
    }},
    {
      $group: {
        _id:               '$clientId',
        totalPuntos:       { $sum: '$puntos' },
        puntosPronosticos: { $sum: { $cond: [{ $eq: ['$tipo', 'pronostico'] }, '$puntos', 0] } },
        puntosBonus:       { $sum: { $cond: [{ $eq: ['$tipo', 'bonificacion'] }, '$puntos', 0] } },
        // Criterio 4: el que llegó antes al puntaje va primero en caso de empate total
        primerPunto:       { $min: '$createdAt' },
      },
    },
    { $sort: { totalPuntos: -1 } },
    {
      $lookup: {
        from: 'clients',
        localField: '_id',
        foreignField: '_id',
        as: 'client',
      },
    },
    { $addFields: {
      clientFound: { $gt: [{ $size: '$client' }, 0] },
      clientData:  { $arrayElemAt: ['$client', 0] },
    }},
    { $match: { clientFound: true } },
    {
      $project: {
        clientId:          '$_id',
        nombre:            '$clientData.name',
        apodo:             { $arrayElemAt: [{ $split: ['$clientData.name', ' '] }, 0] },
        whatsapp:          '$clientData.whatsapp',
        totalPuntos:       1,
        puntosPronosticos: 1,
        puntosBonus:       1,
        puntosCompras:     '$puntosBonus',
        primerPunto:       1,
      },
    },
  ]);

  // ── Agregar participantes con 0 puntos ────────────────────────────
  const conPuntosIds = new Set(ranking.map(r => String(r.clientId)));
  const sinPuntos    = await Pronostico.distinct('clientId');
  const nuevos       = sinPuntos.filter(id => !conPuntosIds.has(String(id)));
  if (nuevos.length > 0) {
    const clients = await require('../models/Order').Client
      .find({ _id: { $in: nuevos } }, 'name whatsapp').lean();
    for (const c of clients) {
      ranking.push({
        clientId:          c._id,
        nombre:            c.name,
        apodo:             c.name?.split(' ')[0] || c.name,
        whatsapp:          c.whatsapp,
        totalPuntos:       0,
        puntosPronosticos: 0,
        puntosBonus:       0,
        puntosCompras:     0,
        primerPunto:       null,
      });
    }
  }

  // ── Criterio 2: marcadores exactos ─────────────────────────────────────
  // Calculamos cuántos pronósticos de cada cliente acertaron el marcador exacto.
  // Se hace fuera del aggregate principal porque requiere cruzar Pronostico con
  // ProdeMatch (homeScore/awayScore), lo que dentro del pipeline sería un doble
  // $lookup anidado difícil de mantener.
  const exactosPorCliente = {};
  try {
    const pronosticos = await Pronostico.find({ evaluated: true, pointsEarned: { $gt: 0 } })
      .select('clientId predictedHome predictedAway matchId')
      .populate('matchId', 'homeScore awayScore')
      .lean();

    for (const p of pronosticos) {
      if (
        p.predictedHome !== null && p.predictedAway !== null &&
        p.matchId &&
        p.predictedHome === p.matchId.homeScore &&
        p.predictedAway === p.matchId.awayScore
      ) {
        const cid = String(p.clientId);
        exactosPorCliente[cid] = (exactosPorCliente[cid] || 0) + 1;
      }
    }
  } catch (e) {
    console.error('⚠️ getRanking: error calculando exactos:', e.message);
  }

  for (const r of ranking) {
    r.marcadoresExactos = exactosPorCliente[String(r.clientId)] || 0;
  }

  // ── Resolver categorías en paralelo ─────────────────────────────────
  await Promise.all(ranking.map(async (r) => {
    if (!r.clientId) return;
    const status = await resolveProdeStatus(r.clientId, cfg);
    r.categoria         = status?.categoria      || 'invitado';
    r.categoriaLabel    = status?.categoriaLabel || 'Invitado';
    r.premioSegmento    = status?.premioSegmento || 'invitado';
    r.elegibleTop3      = status?.elegibleTop3   || false;
    r.entregasEnPeriodo = status?.entregasEnPeriodo || 0;
    r.entregasPreProde  = status?.entregasPreProde  || 0;
    r.pedidosEnPeriodo  = r.entregasEnPeriodo;
  }));

  // ── Sort final con las 4 reglas de desempate ──────────────────────────
  // Regla 1: mayor puntaje total
  // Regla 2: más marcadores exactos (en caso de empate en puntos)
  // Regla 3: más puntos solo de pronósticos, sin bonus (en caso de empate en exactos)
  // Regla 4: el que llegó antes al puntaje — primerPunto más antiguo (last resort)
  ranking.sort((a, b) => {
    if (b.totalPuntos       !== a.totalPuntos)       return b.totalPuntos       - a.totalPuntos;
    if (b.marcadoresExactos !== a.marcadoresExactos) return b.marcadoresExactos - a.marcadoresExactos;
    if (b.puntosPronosticos !== a.puntosPronosticos) return b.puntosPronosticos - a.puntosPronosticos;
    const tA = a.primerPunto ? new Date(a.primerPunto).getTime() : Infinity;
    const tB = b.primerPunto ? new Date(b.primerPunto).getTime() : Infinity;
    return tA - tB;
  });

  return ranking;
}

async function getTop3Competidores() {
  const ranking = await getRanking();
  return ranking.filter(r => r.elegibleTop3).slice(0, 3);
}

async function getPremiosAdmin() {
  const cfg = await getProdeConfig();
  const clientIds = await Pronostico.distinct('clientId');
  if (clientIds.length === 0) {
    return { invitados: [], clientes: [], top3: [] };
  }

  const statuses = await Promise.all(clientIds.map(id => resolveProdeStatus(id)));
  const ranking  = await getRanking();
  const rankMap  = {};
  ranking.forEach((r, i) => { rankMap[String(r.clientId)] = { posicion: i + 1, totalPuntos: r.totalPuntos }; });

  const invitados = [];
  const clientes  = [];

  for (const s of statuses) {
    if (!s) continue;
    const rank = rankMap[String(s.clientId)] || {};
    const row = {
      clientId: s.clientId,
      nombre: s.nombre,
      totalPuntos: rank.totalPuntos || s.totalPuntos,
      posicion: rank.posicion || null,
      cuponInvitado: s.cuponInvitado,
      premio: premioDescripcion(s.premioSegmento, cfg),
    };

    if (s.premioSegmento === 'invitado') invitados.push(row);
    else if (s.premioSegmento === 'cliente') clientes.push(row);
  }

  const top3 = ranking.filter(r => r.elegibleTop3).slice(0, 3).map((r, i) => ({
    posicion: i + 1,
    clientId: r.clientId,
    nombre: r.nombre?.split(' ')[0] || r.nombre,
    totalPuntos: r.totalPuntos,
    categoria: r.categoriaLabel,
    premio: [cfg.prize1, cfg.prize2, cfg.prize3][i] || '',
  }));

  return { invitados, clientes, top3, cfg: {
    prizeInvitado: cfg.prizeInvitado,
    prizeCliente: cfg.prizeCliente,
    prize1: cfg.prize1,
    prize2: cfg.prize2,
    prize3: cfg.prize3,
  }};
}

// Legacy: usado por prode-test — redirige a processProdeCategoryOnDelivery
async function addProdePointsForOrder(clientId, orderId) {
  return processProdeCategoryOnDelivery(clientId, orderId);
}

module.exports = {
  BONUS,
  getProdeConfig,
  isProdeActive,
  syncFixture,
  seedMockFixture,
  processProdeCategoryOnDelivery,
  addProdePointsForOrder,
  registerProdeGuest,
  markProdeRegistered,
  findClientByPhone,
  resolveProdeStatus,
  evaluateMatch,
  getTotalPoints,
  getRanking,
  getTop3Competidores,
  getPremiosAdmin,
  normalizePhone,
  phoneKey,
};