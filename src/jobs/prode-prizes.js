
const cron = require('node-cron');
const { processPendingScheduledSends } = require('../services/prode-prizes.service');

// ── Job: revisa y entrega cupones de premios Prode pendientes (semanas 2-4 del 1er puesto) ──
async function runProdePrizesJob() {
  console.log('\n🏆 [ProdePrizesJob] Revisando cupones de premio pendientes...');
  try {
    const result = await processPendingScheduledSends();
    if (result.delivered > 0) {
      console.log(`✅ [ProdePrizesJob] ${result.delivered} cupón(es) de premio entregado(s).`);
    } else {
      console.log('🏆 [ProdePrizesJob] Sin cupones pendientes para hoy.');
    }
    return result;
  } catch (err) {
    console.error('❌ [ProdePrizesJob] Error:', err.message);
    return { checked: 0, delivered: 0, error: err.message };
  }
}

let cronJob = null;

function startProdePrizesJob() {
  if (cronJob) cronJob.stop();

  // Todos los días a las 11:00hs Argentina (después del job de cumpleaños, sin pisar horarios de carga)
  cronJob = cron.schedule('0 11 * * *', () => {
    runProdePrizesJob().catch(err => console.error('❌ [ProdePrizesJob] Error en cron:', err.message));
  }, { timezone: 'America/Argentina/Buenos_Aires' });

  console.log('🏆 [ProdePrizesJob] Cron registrado: todos los días a las 11:00hs (Argentina)');
}

module.exports = { startProdePrizesJob, runProdePrizesJob };
