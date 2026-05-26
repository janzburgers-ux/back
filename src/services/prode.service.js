const axios = require('axios');
const { ProdeMatch, Pronostico, ProdePoints, ProdeConfig } = require('../models/Prode');
const { Client } = require('../models/Order');
const { sendMessage } = require('./whatsapp');


// ── football-data.org v4 ──────────────────────────────────────────────────────
// Registro gratuito: https://www.football-data.org/client/register
// Plan Free: 10 req/min, sin tarjeta de credito
// Env var requerida: FOOTBALL_DATA_KEY (la key que llega por mail al registrarse)
// Endpoint: GET /v4/competitions/WC/matches  (WC = FIFA World Cup, codigo fijo)
const FOOTBALL_DATA_BASE = 'https://api.football-data.org/v4';

// Mapeo stage football-data.org -> etapa en espanol
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

// "GROUP_A" -> "Grupo A"
function mapGroup(group = '') {
  return group ? group.replace('GROUP_', 'Grupo ') : '';
}

// Estados live y terminado de football-data.org
const LIVE_STATUSES     = ['IN_PLAY', 'PAUSED', 'HALFTIME'];
const FINISHED_STATUSES = ['FINISHED'];

// winner de football-data.org -> nuestro enum
function mapWinner(winner) {
  if (winner === 'HOME_TEAM') return 'home';
  if (winner === 'AWAY_TEAM') return 'away';
  if (winner === 'DRAW')      return 'draw';
  return null;
}


// ── Obtener config activa ─────────────────────────────────────────────────────
async function getProdeConfig() {
  let cfg = await ProdeConfig.findOne({ key: 'prode' });
  if (!cfg) {
    cfg = await ProdeConfig.create({ key: 'prode', value: {} });
  }
  return cfg.value;
}

// ── Verificar si el período de compras está activo ────────────────────────────
async function isProdeActive() {
  const cfg = await getProdeConfig();
  if (!cfg.enabled) return false;
  const now = new Date();
  if (cfg.startDate && now < new Date(cfg.startDate)) return false;
  if (cfg.endDate   && now > new Date(cfg.endDate))   return false;
  return true;
}


// ── Sync fixture desde football-data.org v4 ───────────────────────────────────
async function syncFixture() {
  const FOOTBALL_DATA_KEY = process.env.FOOTBALL_DATA_KEY;

  if (!FOOTBALL_DATA_KEY) {
    return { synced: 0, error: 'FOOTBALL_DATA_KEY no definida en variables de entorno. Registrate en football-data.org y agregala en Railway.' };
  }

  try {
    const { data } = await axios.get(`${FOOTBALL_DATA_BASE}/competitions/WC/matches`, {
      headers: { 'X-Auth-Token': FOOTBALL_DATA_KEY },
      timeout: 15000,
    });

    const matches = data?.matches || [];
    if (!Array.isArray(matches) || matches.length === 0) {
      return { synced: 0, error: 'La API devolvio 0 partidos. Verificar que el Mundial 2026 este disponible en tu plan.' };
    }

    // Construir todas las operaciones de una sola vez → un único bulkWrite en lugar de 104 queries
    const ops = matches.map(m => {
      const apiId     = String(m.id);
      const homeTeam  = m.homeTeam?.name || 'TBD';
      const awayTeam  = m.awayTeam?.name || 'TBD';
      const homeLogo  = m.homeTeam?.crest || '';
      const awayLogo  = m.awayTeam?.crest || '';
      const matchDate = m.utcDate ? new Date(m.utcDate) : null;
      const stage     = mapStage(m.stage || '');
      const group     = mapGroup(m.group || '');

      let status    = 'scheduled';
      let homeScore = null;
      let awayScore = null;
      let winner    = null;

      if (FINISHED_STATUSES.includes(m.status)) {
        status    = 'finished';
        homeScore = m.score?.fullTime?.home ?? null;
        awayScore = m.score?.fullTime?.away ?? null;
        winner    = mapWinner(m.score?.winner);
      } else if (LIVE_STATUSES.includes(m.status)) {
        status = 'live';
      }

      return {
        updateOne: {
          filter: { apiId },
          update: { $set: { homeTeam, awayTeam, homeLogo, awayLogo, matchDate, stage, group, homeScore, awayScore, status, winner } },
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
    // Error 403 = key invalida, 429 = rate limit, 404 = competicion no encontrada
    const status = err.response?.status;
    if (status === 403) return { synced: 0, error: 'API key invalida o sin permisos. Verificar FOOTBALL_DATA_KEY.' };
    if (status === 429) return { synced: 0, error: 'Rate limit alcanzado (10 req/min). Espera un momento y reintenta.' };
    if (status === 404) return { synced: 0, error: 'Competicion WC no encontrada. Puede que el Mundial 2026 aun no este en el sistema.' };
    return { synced: 0, error: err.message };
  }
}


// ── Seed de fixture mockeado (para desarrollo o si la API no tiene el Mundial aún) ──
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
    // 6 partidos por grupo (todos contra todos)
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
      });
      matchIndex++;
    }
  }

  await ProdeMatch.insertMany(matches);
  console.log(`🌱 Prode: ${matches.length} partidos mockeados insertados`);
}

// ── Sumar puntos por compra (incluye bonificaciones) ─────────────────────────
async function addProdePointsForOrder(clientId, orderId, orderTotal, orderItems = []) {
  const active = await isProdeActive();
  if (!active) return null;

  const cfg = await getProdeConfig();
  let puntosTotales = cfg.pointsPerOrder || 1;
  const detalles = [`Pedido confirmado: +${puntosTotales} pt`];

  // ── Evaluar bonificaciones ───────────────────────────────────────────────
  const bonificaciones = (cfg.bonificaciones || []).filter(b => b.activa);
  for (const bon of bonificaciones) {
    let ptsBonus = 0;

    if (bon.tipo === 'gasto_minimo' && bon.montoMinimo > 0) {
      // gastar más de $X = +N puntos
      if (orderTotal >= bon.montoMinimo) {
        ptsBonus = bon.puntos;
        detalles.push(`${bon.descripcion || `Gasto ≥ $${bon.montoMinimo}`}: +${ptsBonus} pt`);
      }
    } else if (bon.tipo === 'por_cada_x' && bon.montoMinimo > 0) {
      // cada $X gastado = +N puntos (se multiplica)
      const veces = Math.floor(orderTotal / bon.montoMinimo);
      if (veces > 0) {
        ptsBonus = bon.puntos * veces;
        detalles.push(`${bon.descripcion || `Cada $${bon.montoMinimo}`} ×${veces}: +${ptsBonus} pt`);
      }
    } else if (bon.tipo === 'producto' && bon.productoId) {
      // comprar X producto = +N puntos
      const tieneProducto = orderItems.some(item => {
        const pid = item.product?._id?.toString() || item.product?.toString() || '';
        return pid === bon.productoId;
      });
      if (tieneProducto) {
        ptsBonus = bon.puntos;
        detalles.push(`${bon.descripcion || `Compra de ${bon.productoNombre}`}: +${ptsBonus} pt`);
      }
    }

    puntosTotales += ptsBonus;
  }

  await ProdePoints.create({
    clientId,
    tipo: 'compra',
    descripcion: detalles.join(' | '),
    puntos: puntosTotales,
    orderId,
  });

  // Notificar por WhatsApp
  try {
    const client = await Client.findById(clientId);
    if (client?.whatsapp) {
      const totalPuntos = await getTotalPoints(clientId);
      const bonusTxt = detalles.length > 1
        ? `\n\n🎁 *Bonificaciones obtenidas:*\n${detalles.slice(1).map(d => `  • ${d}`).join('\n')}`
        : '';
      const msg =
        `🏆 *¡Sumaste puntos al Prode Janz!*\n\n` +
        `Tu pedido suma *+${puntosTotales} punto${puntosTotales > 1 ? 's' : ''}* al ranking del Mundial.${bonusTxt}\n\n` +
        `Tu total actual: *${totalPuntos} pts* 🌟\n\n` +
        `Seguí pidiendo y pronosticando para escalar posiciones.\n\n` +
        `_Janz Burgers_ 🍔⚽`;
      sendMessage(client.whatsapp, msg).catch(e => console.error('WA prode:', e.message));
    }
  } catch (e) {
    console.error('WA prode points:', e.message);
  }

  return { puntos: puntosTotales, detalles };
}

// ── Evaluar pronósticos de un partido terminado ───────────────────────────────
async function evaluateMatch(matchId) {
  const match = await ProdeMatch.findById(matchId);
  if (!match || match.status !== 'finished' || match.winner === null) return;

  const cfg = await getProdeConfig();
  const pronosticos = await Pronostico.find({ matchId, evaluated: false });

  for (const p of pronosticos) {
    let pts = 0;
    if (p.predictedWinner === match.winner) {
      pts += cfg.pointsWinner || 1;
      // Resultado exacto
      if (
        p.predictedHome !== null &&
        p.predictedAway !== null &&
        p.predictedHome === match.homeScore &&
        p.predictedAway === match.awayScore
      ) {
        pts += cfg.pointsExact || 5;
      }
    }

    p.pointsEarned = pts;
    p.evaluated = true;
    await p.save();

    if (pts > 0) {
      await ProdePoints.create({
        clientId:    p.clientId,
        matchId,
        tipo:        'pronostico',
        descripcion: `${match.homeTeam} vs ${match.awayTeam} — ${pts} pts`,
        puntos:      pts,
      });
    }
  }

  console.log(`✅ Evaluados ${pronosticos.length} pronósticos para ${match.homeTeam} vs ${match.awayTeam}`);
}

// ── Obtener total de puntos de un cliente ─────────────────────────────────────
async function getTotalPoints(clientId) {
  const result = await ProdePoints.aggregate([
    { $match: { clientId: new (require('mongoose').Types.ObjectId)(clientId) } },
    { $group: { _id: null, total: { $sum: '$puntos' } } }
  ]);
  return result[0]?.total || 0;
}

// ── Ranking general ───────────────────────────────────────────────────────────
async function getRanking() {
  const ranking = await ProdePoints.aggregate([
    {
      $group: {
        _id: '$clientId',
        totalPuntos: { $sum: '$puntos' },
        puntosPronosticos: { $sum: { $cond: [{ $eq: ['$tipo', 'pronostico'] }, '$puntos', 0] } },
        puntosCompras:     { $sum: { $cond: [{ $eq: ['$tipo', 'compra']    }, '$puntos', 0] } },
      }
    },
    { $sort: { totalPuntos: -1 } },
    {
      $lookup: {
        from: 'clients',
        localField: '_id',
        foreignField: '_id',
        as: 'client'
      }
    },
    { $unwind: '$client' },
    {
      $project: {
        clientId: '$_id',
        nombre: '$client.name',
        whatsapp: '$client.whatsapp',
        totalPuntos: 1,
        puntosPronosticos: 1,
        puntosCompras: 1,
      }
    }
  ]);

  // Agregar cantidad de pedidos en el período activo
  const cfg = await getProdeConfig();
  for (const r of ranking) {
    const { Order } = require('../models/Order');
    const filter = { client: r.clientId };
    if (cfg.startDate) filter.createdAt = { $gte: new Date(cfg.startDate) };
    if (cfg.endDate)   filter.createdAt = { ...filter.createdAt, $lte: new Date(cfg.endDate) };
    r.pedidosEnPeriodo = await Order.countDocuments(filter);
  }

  return ranking;
}

module.exports = {
  getProdeConfig,
  isProdeActive,
  syncFixture,
  seedMockFixture,
  addProdePointsForOrder,
  evaluateMatch,
  getTotalPoints,
  getRanking,
};