const cron = require('node-cron');
const { syncFixture }   = require('../services/prode.service');
const { ProdeMatch }    = require('../models/Prode');
const { evaluateMatch } = require('../services/prode.service');

// ── Evaluar partidos que el sync marcó como finished pero aún no evaluados ────
async function evaluatePendingMatches() {
  // Incluimos partidos finished con winner válido que todavía tienen
  // pronósticos sin evaluar. Si en un sync anterior el winner era null,
  // ahora que el sync lo resolvió, este bloque lo procesa.
  const pendientes = await ProdeMatch.find({
    status: 'finished',
    winner: { $in: ['home', 'away', 'draw'] },   // solo con dato real
    homeScore: { $ne: null },
    awayScore: { $ne: null },
  });

  for (const m of pendientes) {
    await evaluateMatch(m._id);
  }
}

// ── Sync inteligente: cada 5 min entre 10:00 y 02:00 hora Argentina ───────────
// Argentina = UTC-3
// 10:00 AR = 13:00 UTC  →  02:00 AR = 05:00 UTC
// Expresión cron UTC:  */5 13-23,0-4 * * *
// Activo solo durante el Mundial (11 Jun - 19 Jul)
async function runProdeSync() {
  const now = new Date();
  const arDate = new Date(now.toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));

  // Solo correr durante el período del Mundial
  const start = new Date('2026-06-11T00:00:00-03:00');
  const end   = new Date('2026-07-20T00:00:00-03:00'); // +1 día para incluir el cierre del 19
  if (arDate < start || arDate > end) return;

  console.log(`⚽ [ProdeSync] Sincronizando fixture... (${arDate.toLocaleString('es-AR')})`);

  const result = await syncFixture();
  if (result.error) {
    console.error(`❌ [ProdeSync] Error: ${result.error}`);
    return;
  }

  console.log(`✅ [ProdeSync] ${result.synced} partidos actualizados (${result.insertados ?? 0} nuevos, ${result.actualizados ?? 0} modificados)`);

  // Evaluar pronósticos de partidos recién terminados
  await evaluatePendingMatches();
}

function startProdeSync() {
  // Cada 5 minutos entre 13:00 y 05:00 UTC (= 10:00-02:00 AR)
  cron.schedule('*/5 13-23,0-4 * * *', async () => {
    try {
      await runProdeSync();
    } catch (err) {
      console.error('❌ [ProdeSync] Error inesperado:', err.message);
    }
  });

  console.log('⚽ Prode sync job iniciado (cada 5 min, 10:00-02:00 AR, activo 11 Jun - 19 Jul)');
}

module.exports = { startProdeSync };