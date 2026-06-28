const cron        = require('node-cron');
const { Order }   = require('../models/Order');
const Config      = require('../models/Config');
const { sendMessage, getTemplate, fillTemplate } = require('../services/whatsapp');

// ── Obtener config del alerta de cocina ───────────────────────────────────────
async function getKitchenAlertConfig() {
  const cfg = await Config.findOne({ key: 'kitchenAlertSettings' });
  return cfg?.value || {
    enabled: true,
    phoneNumber: '',      // número de WhatsApp de la cocina (sin +, ej: 5491112345678)
    minutesThreshold: 5,  // minutos sin confirmar antes de alertar
  };
}

// ── Lógica principal del job ──────────────────────────────────────────────────
async function runKitchenAlertJob() {
  const config = await getKitchenAlertConfig();

  if (!config.enabled || !config.phoneNumber) return;

  const threshold = Number(config.minutesThreshold) || 5;
  const cutoff    = new Date(Date.now() - threshold * 60 * 1000);

  // Pedidos que siguen en 'pending', creados hace más de X minutos, sin alerta enviada
  const pendingOrders = await Order.find({
    status: 'pending',
    createdAt: { $lte: cutoff },
    kitchenAlertSentAt: { $exists: false }
  }).select('_id publicCode orderNumber client createdAt');

  if (pendingOrders.length === 0) return;

  const defaultTpl = `⚠️ *Alerta de cocina*\n\nHay {cantidad} pedido{plural} sin confirmar hace más de {minutos} minuto{pluralMin}:\n\n{pedidos}\n\n_Janz Burgers — sistema automático_`;
  const tpl = await getTemplate('kitchenAlert', defaultTpl);

  const listLines = pendingOrders
    .map(o => `• *${o.publicCode || o.orderNumber}* — hace ${Math.round((Date.now() - new Date(o.createdAt)) / 60000)} min`)
    .join('\n');

  const message = fillTemplate(tpl, {
    cantidad:   pendingOrders.length,
    plural:     pendingOrders.length !== 1 ? 's' : '',
    minutos:    threshold,
    pluralMin:  threshold !== 1 ? 's' : '',
    pedidos:    listLines,
  });

  const result = await sendMessage(config.phoneNumber, message);

  if (result?.success) {
    // Marcar todos como alertados para no volver a enviar
    const ids = pendingOrders.map(o => o._id);
    await Order.updateMany({ _id: { $in: ids } }, { $set: { kitchenAlertSentAt: new Date() } });
    console.log(`🔔 [KitchenAlert] Alerta enviada por ${pendingOrders.length} pedido(s) sin confirmar.`);
  } else {
    console.warn('🔔 [KitchenAlert] No se pudo enviar la alerta de WhatsApp.');
  }
}

// ── Cron: corre cada minuto ───────────────────────────────────────────────────
let cronJob = null;

function startKitchenAlertJob() {
  if (cronJob) cronJob.stop();

  cronJob = cron.schedule('* * * * *', () => {
    runKitchenAlertJob().catch(err =>
      console.error('❌ [KitchenAlert] Error en cron:', err.message)
    );
  }, { timezone: 'America/Argentina/Buenos_Aires' });

  console.log('🔔 [KitchenAlert] Cron registrado: cada minuto (hora Argentina)');
}

module.exports = { startKitchenAlertJob, runKitchenAlertJob, getKitchenAlertConfig };
