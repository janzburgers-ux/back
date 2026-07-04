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

    // ── Snapshot de lo que ya tenemos guardado, ANTES de pisarlo ────────────────
    // Lo necesitamos para detectar si un resultado "finished" que ya estaba
    // guardado cambia en este sync (ver resultVersion más abajo).
    const apiIds = matches.map(m => String(m.id));
    const existingMatches = await ProdeMatch.find(
      { apiId: { $in: apiIds } },
      'apiId homeScore awayScore resultVersion'
    ).lean();
    const existingByApiId = {};
    existingMatches.forEach(m => { existingByApiId[m.apiId] = m; });

    const ops = matches.map(m => {
      const apiId     = String(m.id);
      const existing  = existingByApiId[apiId] || null;
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
      // Si queda en true, NO escribimos homeScore/awayScore/winner este ciclo:
      // sabemos que el partido terminó pero todavía no tenemos un dato confiable
      // de los 90'. El próximo sync (5 min después) lo vuelve a intentar.
      let scoreNotReadyYet = false;

      if (FINISHED_STATUSES.includes(m.status)) {
        status = 'finished';
        const rt       = m.score?.regularTime;
        const ft       = m.score?.fullTime;
        const et       = m.score?.extraTime;
        const pk       = m.score?.penalties;
        const duration = m.score?.duration || 'REGULAR';
        const wentExtra = duration === 'EXTRA_TIME' || duration === 'PENALTY_SHOOTOUT';

        // Verificar explícitamente !== null porque la API puede mandar { home: null, away: null }
        const rtHome = (rt?.home !== null && rt?.home !== undefined) ? rt.home : null;
        const rtAway = (rt?.away !== null && rt?.away !== undefined) ? rt.away : null;
        const ftHome = (ft?.home !== null && ft?.home !== undefined) ? ft.home : null;
        const ftAway = (ft?.away !== null && ft?.away !== undefined) ? ft.away : null;

        if (wentExtra) {
          // FIX bug "lectura de resultado / alargue / penales":
          // en partidos que fueron a alargue o penales, football-data.org
          // reporta en `fullTime` el acumulado de TODO (90' + alargue + penales),
          // no el resultado de los 90'. El prode se juega SOLO sobre los 90',
          // así que en este caso `fullTime` NO es un fallback válido — sólo
          // confiamos en `regularTime`. Si todavía no está publicado (puede
          // tardar unos minutos en aparecer tras el pitazo final), no fijamos
          // ningún resultado todavía en vez de guardar uno incorrecto.
          if (rtHome !== null && rtAway !== null) {
            homeScore = rtHome;
            awayScore = rtAway;
          } else {
            scoreNotReadyYet = true;
            console.warn(`⚠️ [ProdeSync] ${homeTeam} vs ${awayTeam} terminó (${duration}) pero regularTime (90') aún no está disponible. Se reintenta en el próximo sync. score crudo:`, JSON.stringify(m.score));
          }
        } else {
          // Partido sin alargue: fullTime ES el resultado de los 90'.
          homeScore = ftHome;
          awayScore = ftAway;
        }

        if (!scoreNotReadyYet && (homeScore === null || awayScore === null)) {
          console.warn(`⚠️ [ProdeSync] ${homeTeam} vs ${awayTeam} | apiStatus=${m.status} | score crudo:`, JSON.stringify(m.score));
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

      if (scoreNotReadyYet) {
        // No marcamos como 'finished' todavía: si lo hiciéramos sin homeScore/
        // awayScore, evaluateMatch() lo ignora (chequea winner === null) pero
        // quedaría "finished" sin resultado, lo cual es confuso en el panel.
        // Lo dejamos como 'live' — el próximo sync (5 min) lo termina de cerrar.
        status = 'live';
      }

      $setFields.status = status;

      if (status === 'finished' || status === 'live') {
        if (homeScore !== null) $setFields.homeScore = homeScore;
        if (awayScore !== null) $setFields.awayScore = awayScore;
        if (winner    !== null) $setFields.winner    = winner;

        // ── Detectar resultado corregido post-hoc ─────────────────────────────
        // Si el partido YA estaba guardado como finished con un resultado real
        // y ahora llega un resultado distinto, es una corrección (típicamente
        // el caso de arriba: el primer sync usó un dato provisorio). Subimos
        // resultVersion para que el cron de evaluación detecte que los
        // pronósticos ya evaluados de este partido quedaron desactualizados
        // y los vuelva a evaluar con el resultado correcto.
        if (
          status === 'finished' && homeScore !== null && awayScore !== null &&
          existing && existing.homeScore !== null && existing.homeScore !== undefined &&
          existing.awayScore !== null && existing.awayScore !== undefined &&
          (existing.homeScore !== homeScore || existing.awayScore !== awayScore)
        ) {
          $setFields.resultVersion = (existing.resultVersion || 0) + 1;
          console.warn(`⚠️ [ProdeSync] Resultado corregido en ${homeTeam} vs ${awayTeam}: ${existing.homeScore}-${existing.awayScore} → ${homeScore}-${awayScore}. resultVersion → ${$setFields.resultVersion}`);
        }
      } else {
        // scheduled: el partido no ocurrió aún, limpiar scores
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
    // Dejamos registrado contra qué versión del resultado se evaluó este
    // pronóstico (ver resultVersion en el modelo). Si el resultado se corrige
    // más adelante, reevaluateChangedMatches() lo detecta por este campo.
    p.evaluatedResultVersion = match.resultVersion || 0;
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

// ── Resetear evaluación de un partido (para volver a evaluarlo limpio) ──────────
// Se usa tanto cuando un admin corrige el resultado a mano (PUT /fixture/:id/resultado)
// como automáticamente cuando el sync detecta que un resultado ya evaluado cambió
// (ver resultVersion / reevaluateChangedMatches).
async function resetMatchEvaluation(matchId) {
  await ProdePoints.deleteMany({ matchId, tipo: 'pronostico' });
  await Pronostico.updateMany(
    { matchId },
    { $set: { evaluated: false, pointsEarned: 0, evaluatedResultVersion: -1 } }
  );
}

// ── Re-evaluar partidos cuyo resultado cambió DESPUÉS de haber sido evaluado ────
// FIX bug "lectura de resultado del prode": antes, si syncFixture guardaba un
// resultado provisorio incorrecto (típicamente en partidos con alargue/penales,
// ver syncFixture) y evaluateMatch ya había repartido puntos con ese dato, una
// corrección posterior del resultado NUNCA se reflejaba en los puntos: quedaban
// evaluados para siempre con el dato viejo. Esta función busca exactamente esos
// casos (evaluatedResultVersion desactualizado) y los vuelve a evaluar.
async function reevaluateChangedMatches() {
  const desync = await Pronostico.aggregate([
    { $match: { evaluated: true } },
    {
      $lookup: {
        from: 'prodematches',
        localField: 'matchId',
        foreignField: '_id',
        as: 'match',
      },
    },
    { $unwind: '$match' },
    {
      $match: {
        $expr: { $ne: ['$evaluatedResultVersion', { $ifNull: ['$match.resultVersion', 0] }] },
      },
    },
    { $group: { _id: '$matchId' } },
  ]);

  for (const { _id: matchId } of desync) {
    await resetMatchEvaluation(matchId);
    await evaluateMatch(matchId);
  }

  if (desync.length > 0) {
    console.log(`🔁 [ProdeSync] Re-evaluados ${desync.length} partido(s) con resultado corregido.`);
  }
  return { reevaluated: desync.length };
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
        Number(p.predictedHome) === Number(p.matchId.homeScore) &&
        Number(p.predictedAway) === Number(p.matchId.awayScore)
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

  // ── Resolver categorías en BATCH (no O(n)) ───────────────────────────────
  // FIX rendimiento: antes hacía resolveProdeStatus(clientId) por cada
  // participante — 5 queries × N participantes (Client.findById, 2×
  // countDocuments, ProdePoints.find, getTotalPoints). Con 50 participantes
  // = 250 queries. Ahora son 3 queries totales que traen todos los datos.
  const allClientIds = ranking.map(r => r.clientId).filter(Boolean);

  // 1) Entregas en período y pre-Prode: un solo aggregate agrupa por clientId
  const { start: pStart, end: pEnd } = cfg.startDate
    ? { start: new Date(cfg.startDate), end: cfg.endDate ? new Date(cfg.endDate) : new Date() }
    : { start: new Date(0), end: new Date() };

  const prodeStart = cfg.startDate ? new Date(cfg.startDate) : null;

  const deliveryBatch = await Order.aggregate([
    {
      $match: {
        client: { $in: allClientIds },
        status: 'delivered',
      },
    },
    {
      $group: {
        _id: '$client',
        entregasTotal: { $sum: 1 },
        entregasEnPeriodo: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $gte: ['$deliveredAt', pStart] },
                  { $lte: ['$deliveredAt', pEnd] },
                ],
              },
              1, 0,
            ],
          },
        },
        entregasPreProde: {
          $sum: {
            $cond: [
              prodeStart
                ? { $lt: ['$deliveredAt', prodeStart] }
                : { $eq: [1, 0] }, // si no hay startDate, nada es pre-prode
              1, 0,
            ],
          },
        },
      },
    },
  ]);

  const deliveryMap = {};
  deliveryBatch.forEach(d => {
    deliveryMap[String(d._id)] = {
      entregasEnPeriodo: d.entregasEnPeriodo || 0,
      entregasPreProde:  d.entregasPreProde  || 0,
    };
  });

  // 2) Bonificaciones de categoría: un solo find para todos los participantes
  const bonusBatch = await ProdePoints.find({
    clientId: { $in: allClientIds },
    tipo: 'bonificacion',
    subtipo: { $in: [BONUS.UPGRADE_CLIENTE, BONUS.UPGRADE_VIP] },
  }).select('clientId subtipo puntos').lean();

  const bonusMap = {};
  bonusBatch.forEach(b => {
    const cid = String(b.clientId);
    if (!bonusMap[cid]) bonusMap[cid] = {};
    bonusMap[cid][b.subtipo] = b.puntos;
  });

  // 3) Aplicar al ranking usando los datos en memoria
  for (const r of ranking) {
    const cid = String(r.clientId);
    const del = deliveryMap[cid] || { entregasEnPeriodo: 0, entregasPreProde: 0 };

    const categoria      = resolveCategoria(del.entregasPreProde, del.entregasEnPeriodo);
    const premioSegmento = resolvePremioSegmento(del.entregasPreProde, del.entregasEnPeriodo);

    r.categoria          = categoria;
    r.categoriaLabel     = categoria === 'vip' ? 'VIP' : categoria === 'cliente' ? 'Cliente' : 'Invitado';
    r.premioSegmento     = premioSegmento;
    r.elegibleTop3       = del.entregasEnPeriodo >= 1;
    r.entregasEnPeriodo  = del.entregasEnPeriodo;
    r.entregasPreProde   = del.entregasPreProde;
    r.pedidosEnPeriodo   = del.entregasEnPeriodo;
  }

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
  resetMatchEvaluation,
  reevaluateChangedMatches,
  getTotalPoints,
  getRanking,
  getTop3Competidores,
  getPremiosAdmin,
  normalizePhone,
  phoneKey,
};