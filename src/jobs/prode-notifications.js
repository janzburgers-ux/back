const cron = require('node-cron');
const { Pronostico }                   = require('../models/Prode');
const { Client }                       = require('../models/Order');
const { resolveProdeStatus,
        getProdeConfig }               = require('../services/prode.service');
const { sendMessage }                  = require('../services/whatsapp');

// ── Construir mensaje resumen diario ─────────────────────────────────────────
function buildDailyProdeMessage(status, prons, cfg = {}) {
  const nombre = status.nombre || 'Participante';
  const pct    = cfg.guestCouponPercent || 15;

  // ── Líneas de partidos ──
  const acertados = [];
  const fallados  = [];

  for (const p of prons) {
    const match = p.matchId;
    if (!match) continue;

    const hs = match.homeScore ?? '?';
    const as = match.awayScore ?? '?';
    const resultado  = `${match.homeTeam} ${hs}-${as} ${match.awayTeam}`;
    const predLabel  = { home: match.homeTeam, away: match.awayTeam, draw: 'Empate' }[p.predictedWinner] || '?';

    if (p.pointsEarned > 0) {
      const wasExact =
        p.predictedHome !== null &&
        p.predictedAway !== null &&
        p.predictedHome === match.homeScore &&
        p.predictedAway === match.awayScore;

      const detalle = wasExact
        ? `¡Exacto! (${p.predictedHome}-${p.predictedAway}) → *+${p.pointsEarned} pts* 🎯`
        : `Acertaste el ganador → *+${p.pointsEarned} pts* 👍`;

      acertados.push(`✅ *${resultado}*\n   ${detalle}`);
    } else {
      acertados.length === 0 && fallados.length === 0
        ? fallados.push(`❌ *${resultado}*\n   Pronosticaste: ${predLabel}`)
        : fallados.push(`❌ *${resultado}*\n   Pronosticaste: ${predLabel}`);
    }
  }

  const totalHoy   = prons.reduce((s, p) => s + (p.pointsEarned || 0), 0);
  const lineas     = [...acertados, ...fallados].join('\n\n');
  const resumenPts = totalHoy > 0
    ? `\n🎯 *Sumaste hoy: +${totalHoy} pts*`
    : `\n😔 Sin puntos hoy — ¡el próximo partido es el tuyo!`;

  // ── Situación actual ──
  let situacionMsg = '';
  if (status.premioSegmento === 'competidor') {
    situacionMsg =
      `🏆 *¡Estás en los premios exclusivos!*\n` +
      `Con 2+ compras en el Mundial competís por el podio (Top 3).\n` +
      `¡Seguí pronosticando para escalar posiciones!`;

  } else if (status.premioSegmento === 'cliente') {
    if (status.entregasEnPeriodo >= 1) {
      situacionMsg =
        `✅ *Participás por el Combo Doble.*\n` +
        `Con 1 compra más (total 2) durante el Mundial → *premios exclusivos*. 🔥`;
    } else {
      situacionMsg =
        `✅ *Ya sos cliente → competís por el Combo Doble a elección.*\n` +
        `Hacé 2 compras durante el Mundial → *premios exclusivos*. 🔥`;
    }
  } else {
    situacionMsg =
      `👋 *Sos Invitado* — Tenés un *cupón del ${pct}%* para tu primera compra.\n` +
      `Hacé 1 compra en Janz durante el Mundial y empezás a competir por premios. 🎁`;
  }

  return (
    `⚽ *Prode Janz — Resumen del día*\n\n` +
    `¡Hola ${nombre}! Acá va el balance de los partidos de hoy:\n\n` +
    lineas +
    `\n\n` +
    resumenPts + `\n` +
    `📊 *Total acumulado: ${status.totalPuntos} pts*\n` +
    `🏷️ Categoría: *${status.categoriaLabel}*\n\n` +
    situacionMsg +
    `\n\n_Janz Burgers_ 🍔⚽`
  );
}

// ── Job principal ─────────────────────────────────────────────────────────────
async function runProdeNotifications() {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000); // últimas 24hs

  // Todos los pronósticos evaluados en el período
  const pronosticos = await Pronostico.find({
    evaluated: true,
    updatedAt: { $gte: since },
  }).populate('matchId').lean();

  if (!pronosticos.length) {
    console.log('⚽ [ProdeNotif] Sin pronósticos evaluados en las últimas 24hs. Nada para enviar.');
    return { sent: 0, skipped: 0 };
  }

  // Agrupar por clientId
  const byClient = {};
  for (const p of pronosticos) {
    const cid = String(p.clientId);
    if (!byClient[cid]) byClient[cid] = [];
    byClient[cid].push(p);
  }

  const cfg = await getProdeConfig();
  let sent = 0, skipped = 0;

  for (const [clientId, prons] of Object.entries(byClient)) {
    try {
      const client = await Client.findById(clientId).select('name whatsapp phone').lean();
      const waNum  = client?.whatsapp || client?.phone || '';

      if (!waNum) {
        console.log(`⚽ [ProdeNotif] Sin WhatsApp para cliente ${clientId}, saltando.`);
        skipped++;
        continue;
      }

      const status = await resolveProdeStatus(clientId);
      if (!status) { skipped++; continue; }

      const msg = buildDailyProdeMessage(status, prons, cfg);
      await sendMessage(waNum, msg);
      sent++;

      console.log(`✅ [ProdeNotif] Resumen enviado a ${client.name} (${prons.length} partidos)`);

      // Pausa entre mensajes para no saturar WhatsApp
      await new Promise(r => setTimeout(r, 1500));

    } catch (e) {
      console.error(`❌ [ProdeNotif] Error con cliente ${clientId}:`, e.message);
      skipped++;
    }
  }

  console.log(`⚽ [ProdeNotif] Fin: ${sent} enviados, ${skipped} saltados.`);
  return { sent, skipped };
}

// ── Registrar cron: todos los días a las 09:00hs Argentina ───────────────────
let cronJob = null;

function startProdeNotificationsJob() {
  if (cronJob) cronJob.stop();

  // 09:00 AR = 12:00 UTC (UTC-3)
  cronJob = cron.schedule('0 12 * * *', () => {
    runProdeNotifications().catch(err =>
      console.error('❌ [ProdeNotif] Error en cron:', err.message)
    );
  }, { timezone: 'America/Argentina/Buenos_Aires' });

  console.log('⚽ [ProdeNotif] Cron registrado: todos los días a las 09:00hs (Argentina)');
}

module.exports = { startProdeNotificationsJob, runProdeNotifications, buildDailyProdeMessage };