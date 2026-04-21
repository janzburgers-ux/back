const cron = require('node-cron');
const { Order, Client } = require('../models/Order');
const Config = require('../models/Config');
const Coupon = require('../models/Coupon');
const { sendMessage } = require('../services/whatsapp');

// ── Obtener config del mensaje de churn ───────────────────────────────────────
async function getChurnConfig() {
  const cfg = await Config.findOne({ key: 'churnAlert' });
  return cfg?.value || {
    enabled: true,
    daysThreshold: 21,
    minOrders: 2,
    generateCoupon: true,
    couponPercent: 10,
    schedule: '0 10 * * 1', // Lunes a las 10am
    message: `¡Hola {nombre}! 🍔\n\n¿Todo bien? Hace un tiempo que no pedís y nos re extrañás jaja.\n\nTe mandamos un regalito: usá el código *{codigo}* y te hacemos un *{descuento}% de descuento* en tu próximo pedido. 🎁\n\n¡Nos vemos pronto!\n_Janz Burgers_ 🔥`
  };
}

// ── Generar cupón de reactivación ─────────────────────────────────────────────
async function generateReactivationCoupon(client, percent) {
  const { generateCouponCode } = require('../services/loyalty');
  const code = generateCouponCode(client.nickname || client.name?.split(' ')[0] || 'CLI');

  // Verificar que no exista uno activo para este cliente
  const existing = await Coupon.findOne({ owner: client._id, active: true, type: 'reactivation' });
  if (existing) return existing.code;

  const coupon = new Coupon({
    code,
    owner: client._id,
    ownerName: client.name,
    discountForUser: percent,
    rewardPerUse: 0,
    type: 'reactivation'
  });
  await coupon.save();
  return code;
}

// ── Formatear mensaje con variables ──────────────────────────────────────────
function buildMessage(template, vars) {
  return template
    .replace(/{nombre}/g, vars.nombre)
    .replace(/{codigo}/g, vars.codigo || '—')
    .replace(/{descuento}/g, vars.descuento || '10')
    .replace(/{dias}/g, vars.dias || '');
}

// ── Job principal ─────────────────────────────────────────────────────────────
async function runChurnAlertJob(manual = false) {
  console.log(`\n🤖 [ChurnAlert] Iniciando job ${manual ? '(manual)' : '(automático)'}...`);

  const config = await getChurnConfig();
  if (!config.enabled && !manual) {
    console.log('🤖 [ChurnAlert] Job deshabilitado en config.');
    return { sent: 0, skipped: 0, message: 'Job deshabilitado' };
  }

  const now = new Date();
  const threshold = config.daysThreshold || 21;
  const minOrders = config.minOrders || 2;

  // Buscar clientes en riesgo
  const atRisk = await Order.aggregate([
    { $match: { status: { $ne: 'cancelled' } } },
    { $group: { _id: '$client', lastOrder: { $max: '$createdAt' }, totalOrders: { $sum: 1 } } },
    {
      $addFields: {
        daysSince: { $divide: [{ $subtract: [now, '$lastOrder'] }, 86400000] }
      }
    },
    { $match: { daysSince: { $gte: threshold }, totalOrders: { $gte: minOrders } } },
    { $sort: { daysSince: -1 } }
  ]);

  const clientIds = atRisk.map(r => r._id);
  const clients = await Client.find({ _id: { $in: clientIds }, active: true });
  const clientMap = {};
  clients.forEach(c => { clientMap[c._id.toString()] = c; });

  let sent = 0, skipped = 0;
  const results = [];

  for (const risk of atRisk) {
    const client = clientMap[risk._id.toString()];
    if (!client?.whatsapp) { skipped++; continue; }

    try {
      let couponCode = '—';
      let descuento = config.couponPercent || 10;

      if (config.generateCoupon) {
        couponCode = await generateReactivationCoupon(client, descuento);
      }

      const msg = buildMessage(config.message, {
        nombre:   client.nickname || client.name.split(' ')[0],
        codigo:   couponCode,
        descuento: descuento,
        dias:     Math.round(risk.daysSince)
      });

      const result = await sendMessage(client.whatsapp, msg);
      if (result?.success) {
        sent++;
        results.push({ name: client.name, status: 'enviado', coupon: couponCode });
        console.log(`✅ [ChurnAlert] Mensaje enviado a ${client.name}`);
      } else {
        skipped++;
        results.push({ name: client.name, status: 'error_wa' });
      }

      // Pausa entre mensajes para no quemar el WA
      await new Promise(r => setTimeout(r, 2000));

    } catch (err) {
      console.error(`❌ [ChurnAlert] Error con ${client.name}:`, err.message);
      skipped++;
      results.push({ name: client.name, status: 'error', error: err.message });
    }
  }

  console.log(`🤖 [ChurnAlert] Fin: ${sent} enviados, ${skipped} salteados.\n`);

  // Guardar log del último run
  await Config.findOneAndUpdate(
    { key: 'churnAlertLastRun' },
    { $set: { key: 'churnAlertLastRun', value: { date: now, sent, skipped, results } } },
    { upsert: true }
  );

  return { sent, skipped, results };
}

// ── Registrar cron ─────────────────────────────────────────────────────────────
let cronJob = null;

async function startChurnJob() {
  const config = await getChurnConfig();
  const schedule = config.schedule || '0 10 * * 1';

  if (cronJob) cronJob.stop();

  cronJob = cron.schedule(schedule, () => {
    runChurnAlertJob(false).catch(err => console.error('❌ [ChurnAlert] Error en cron:', err.message));
  }, { timezone: 'America/Argentina/Buenos_Aires' });

  console.log(`🤖 [ChurnAlert] Cron registrado: "${schedule}" (hora Argentina)`);
}

module.exports = { startChurnJob, runChurnAlertJob, getChurnConfig };