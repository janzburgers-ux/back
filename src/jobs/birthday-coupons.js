const cron = require('node-cron');
const { Client } = require('../models/Order');
const Coupon     = require('../models/Coupon');
const { sendMessage } = require('../services/whatsapp');
const { generateCouponCode, friendlyName } = require('../services/loyalty');

// ── Job principal ─────────────────────────────────────────────────────────────
async function runBirthdayJob() {
  // Fecha actual en timezone Argentina
  const arNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
  const today = { day: arNow.getDate(), month: arNow.getMonth() + 1 };

  console.log(`\n🎂 [BirthdayJob] Buscando cumpleañeros del día ${today.day}/${today.month}...`);

  // Buscar clientes que cumplen hoy y tienen whatsapp
  const clients = await Client.find({
    birthDay:   today.day,
    birthMonth: today.month,
    whatsapp:   { $exists: true, $ne: '' },
    active:     true
  });

  if (!clients.length) {
    console.log('🎂 [BirthdayJob] Sin cumpleañeros hoy.');
    return { sent: 0, skipped: 0 };
  }

  console.log(`🎂 [BirthdayJob] ${clients.length} cumpleañero${clients.length !== 1 ? 's' : ''} encontrado${clients.length !== 1 ? 's' : ''}.`);

  let sent = 0, skipped = 0;

  for (const client of clients) {
    try {
      // Verificar que no tenga ya un cupón de cumple activo (evitar duplicados si el job corre 2 veces)
      const alreadySent = await Coupon.findOne({
        owner:     client._id,
        type:      'birthday',
        createdAt: { $gte: new Date(arNow.getFullYear(), arNow.getMonth(), arNow.getDate()) }
      });

      if (alreadySent) {
        console.log(`🎂 [BirthdayJob] ${client.name} ya tiene cupón de hoy, saltando.`);
        skipped++;
        continue;
      }

      // Generar código JB-APODO-X9
      const code = generateCouponCode(client.nickname || client.name?.split(' ')[0] || 'CLI');
      const friendly = friendlyName(client);

      // Válido 30 días desde el cumpleaños
      const expiresAt = new Date(arNow);
      expiresAt.setDate(expiresAt.getDate() + 30);

      const coupon = new Coupon({
        code,
        owner:           client._id,
        ownerName:       client.name,
        type:            'birthday',
        discountForUser: 15,
        rewardPerUse:    0,
        unlimited:       false,
        singleUse:       true,
        active:          true,
        expiresAt,
      });
      await coupon.save();

      // Enviar WA
      const msg =
        `🎂 ¡Feliz cumpleaños ${friendly}!\n\n` +
        `De parte de todo el equipo de *Janz Burgers*, te mandamos un regalo 🎁\n\n` +
        `Usá el código *${code}* y tenés *15% de descuento* en tu próximo pedido.\n\n` +
        `Válido durante 30 días. ¡Que lo disfrutes!\n\n` +
        `_Janz Burgers_ 🍔🎉`;

      await sendMessage(client.whatsapp, msg);
      sent++;
      console.log(`✅ [BirthdayJob] Cupón de cumple enviado a ${client.name} → ${code}`);

      // Pausa entre mensajes
      await new Promise(r => setTimeout(r, 1000));

    } catch (err) {
      console.error(`❌ [BirthdayJob] Error con ${client.name}:`, err.message);
      skipped++;
    }
  }

  console.log(`🎂 [BirthdayJob] Fin: ${sent} enviados, ${skipped} saltados.\n`);
  return { sent, skipped };
}

// ── Registrar cron: todos los días a las 17:00hs Argentina ───────────────────
let cronJob = null;

function startBirthdayJob() {
  if (cronJob) cronJob.stop();

  // "0 17 * * *" = todos los días a las 17:00hs
  cronJob = cron.schedule('0 17 * * *', () => {
    runBirthdayJob().catch(err => console.error('❌ [BirthdayJob] Error en cron:', err.message));
  }, { timezone: 'America/Argentina/Buenos_Aires' });

  console.log('🎂 [BirthdayJob] Cron registrado: todos los días a las 17:00hs (Argentina)');
}

module.exports = { startBirthdayJob, runBirthdayJob };