const cron = require('node-cron');
const { syncFixture, evaluateMatch, reevaluateChangedMatches } = require('../services/prode.service');
const { ProdeMatch, Pronostico } = require('../models/Prode');

// ── Evaluar partidos que el sync marcó como finished pero aún no evaluados ────
async function evaluatePendingMatches() {
  // Primero buscamos qué partidos tienen pronósticos sin evaluar — así evitamos
  // recorrer TODOS los partidos finished (que crece a ~104 con el torneo avanzado)
  // en cada corrida del cron, cuando en la inmensa mayoría no hay nada pendiente.
  const matchIds = await Pronostico.distinct('matchId', { evaluated: false });
  if (matchIds.length === 0) return;

  const pendientes = await ProdeMatch.find({
    _id: { $in: matchIds },
    status: 'finished',
    winner: { $in: ['home', 'away', 'draw'] },   // solo con dato real
    homeScore: { $ne: null },
    awayScore: { $ne: null },
  });

  for (const m of pendientes) {
    await evaluateMatch(m._id);
  }
}

// ── Sync: cada 5 min, ventana ampliada 08:00 a 03:00 hora Argentina ───────────
// Activo solo entre el 11 Jun y el 19 Jul (chequeo de fecha más abajo)
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

  // FIX bug "lectura de resultado": si algún partido fue evaluado con un
  // resultado provisorio incorrecto (90' vs alargue/penales, ver syncFixture)
  // y la API lo corrigió después, esto detecta esos casos por resultVersion
  // y re-evalúa con el dato correcto, sin intervención manual.
  await reevaluateChangedMatches();
}

function startProdeSync() {
  // Cada 5 minutos entre 08:00 y 03:00 hora Argentina (ventana ampliada;
  // antes era 10:00-02:00). Argentina = UTC-3, así que:
  //   08:00 AR = 11:00 UTC   →   03:00 AR (día siguiente) = 06:00 UTC
  // Expresión cron en UTC: horas 11 a 23, y 0 a 5.
  // Con esto se cubren ~228 consultas/día (19hs × 12 corridas/hora), muy por
  // debajo del límite de 10/min de football-data.org.
  cron.schedule('*/5 11-23,0-5 * * *', async () => {
    try {
      await runProdeSync();
    } catch (err) {
      console.error('❌ [ProdeSync] Error inesperado:', err.message);
    }
  });

  console.log('⚽ Prode sync job iniciado (cada 5 min, 08:00-03:00 AR, activo 11 Jun - 19 Jul)');
}

module.exports = { startProdeSync };