const cron = require('node-cron');
const { Pronostico }                   = require('../models/Prode');
const { Client }                       = require('../models/Order');
const { resolveProdeStatus,
        getProdeConfig,
        getRanking }                   = require('../services/prode.service');
const { sendMessage }                  = require('../services/whatsapp');

// ── Construir mensaje resumen diario ─────────────────────────────────────────
function buildDailyProdeMessage(status, prons, cfg = {}, rankingPos = null) {
  const nombre = status.nombre || 'Participante';
  const pct    = cfg.guestCouponPercent || 15;

  // Fecha de hoy (hora Argentina), en español, ej: "Miércoles 17 de junio"
  const fechaRaw = new Intl.DateTimeFormat('es-AR', {
    weekday: 'long',
    day:     'numeric',
    month:   'long',
    timeZone: 'America/Argentina/Buenos_Aires',
  }).format(new Date());
  const fechaHoy = fechaRaw.charAt(0).toUpperCase() + fechaRaw.slice(1);

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
      fallados.push(`❌ *${resultado}*\n   Pronosticaste: ${predLabel}`);
    }
  }

  const totalHoy   = prons.reduce((s, p) => s + (p.pointsEarned || 0), 0);
  const lineas     = [...acertados, ...fallados].join('\n\n');
  const resumenPts = totalHoy > 0
    ? `\n🎯 *Sumaste hoy: +${totalHoy} pts*`
    : `\n😔 Sin puntos hoy — ¡el próximo partido es el tuyo!`;

  // ── Línea de ranking ──
  const rankingLine = rankingPos
    ? `📍 Vas #${rankingPos} en el ranking. Seguí pronosticando y sumando puntos — ¡esto recién empieza!`
    : `📍 Seguí pronosticando y sumando puntos — ¡esto recién empieza!`;

  // ── Bloque de situación según compras durante el mundial ──
  // Todos necesitan 2 compras durante el mundial para llegar a VIP, sin excepción.
  // entregasEnPeriodo: compras entregadas DURANTE el mundial (el único contador que importa)
  // entregasPreProde:  compras previas al mundial (solo sirve para saber si mostrar el cupón)
  const ep  = status.entregasEnPeriodo;   // 0, 1, ≥2
  const epp = status.entregasPreProde;    // 0 = nunca compró antes

  let situacionMsg = '';

  if (ep >= 2) {
    // VIP — ya llegó, solo motivación de ranking
    situacionMsg =
      `🏆 *¡Sos Cliente VIP!* Estás compitiendo por los premios principales.\n` +
      `El ranking se mueve partido a partido — cada pronóstico acertado te acerca al podio.\n` +
      `¡Seguí así!`;

  } else if (ep === 1) {
    // 1 compra durante el mundial — le falta 1 para VIP (aplica a todos por igual)
    situacionMsg =
      `✅ *Ya estás compitiendo por el Combo Doble.* ¡Bien!\n` +
      `Te falta *1 sola compra más* durante el Mundial para subir a *VIP*:\n` +
      `→ Entrás a los premios principales y competís por el podio del ranking. 🏆\n` +
      `¡Estás a un paso!`;

  } else if (epp === 0) {
    // 0 compras durante el mundial + nunca compró antes = Invitado puro → mostrar cupón
    situacionMsg =
      `🎁 *Todavía no compraste en Janz* — ¡pero podés sumar premios!\n` +
      `Tenés un cupón del *${pct}%* para tu primera compra.\n\n` +
      `Con tus compras durante el Mundial:\n` +
      `→ 1 compra → *Cliente:* competís por un Combo Doble 🍔🍔\n` +
      `→ 2 compras → *VIP:* entrás a los premios principales del ranking 🏆`;

  } else {
    // 0 compras durante el mundial + ya compró antes = Cliente viejo sin compras del mundial
    situacionMsg =
      `🍔 *Ya sos cliente de Janz* — ahora sumá puntos adentro del Mundial también.\n` +
      `Con tus compras durante el torneo:\n` +
      `→ 1 compra → competís por un Combo Doble 🍔🍔\n` +
      `→ 2 compras → *VIP:* entrás a los premios principales del ranking 🏆`;
  }

  return (
    `⚽ *Prode Janz — Resumen del día*\n` +
    `📅 ${fechaHoy}\n\n` +
    `¡Hola ${nombre}! Acá va el balance de los partidos de hoy:\n\n` +
    lineas +
    `\n\n` +
    resumenPts + `\n` +
    `📊 *Total acumulado: ${status.totalPuntos} pts*\n` +
    `🏷️ Categoría: *${status.categoriaLabel}*\n\n` +
    rankingLine + `\n\n` +
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

  // Cargar ranking una sola vez para todos — más eficiente que consultar por cliente
  let rankingMap = {};
  try {
    const ranking = await getRanking();
    ranking.forEach((r, i) => {
      rankingMap[String(r.clientId || r._id)] = i + 1;
    });
  } catch (e) {
    console.error('⚽ [ProdeNotif] No se pudo cargar el ranking:', e.message);
  }

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

      const rankingPos = rankingMap[String(clientId)] || null;
      const msg = buildDailyProdeMessage(status, prons, cfg, rankingPos);
      await sendMessage(waNum, msg);
      sent++;

      console.log(`✅ [ProdeNotif] Resumen enviado a ${client.name} (${prons.length} partidos, #${rankingPos ?? '?'} en ranking)`);

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

// ── Registrar cron: hora configurable desde ProdeConfig ──────────────────────
let cronJob = null;
let lastFiredDate = null; // guard: evitar doble disparo en el mismo día/hora

async function getNotifHour() {
  try {
    const { getProdeConfig } = require('../services/prode.service');
    const cfg = await getProdeConfig();
    // notifHour: número 0-23 (hora en Argentina). Default: 9
    const h = Number(cfg.notifHour);
    if (!isNaN(h) && h >= 0 && h <= 23) return h;
  } catch (e) { /* ignorar */ }
  return 9;
}

function startProdeNotificationsJob() {
  if (cronJob) cronJob.stop();

  // Programar cron dinámico que lee la hora de config en cada ejecución
  cronJob = cron.schedule('* * * * *', async () => {
    try {
      const hora = await getNotifHour();
      const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
      if (now.getHours() === hora && now.getMinutes() === 0) {
        // Guard: no disparar más de una vez por hora (evita doble-fire)
        const fireKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${hora}`;
        if (lastFiredDate === fireKey) return;
        lastFiredDate = fireKey;

        runProdeNotifications().catch(err =>
          console.error('❌ [ProdeNotif] Error en cron:', err.message)
        );
      }
    } catch (e) {
      console.error('❌ [ProdeNotif] Error leyendo hora config:', e.message);
    }
  }, { timezone: 'America/Argentina/Buenos_Aires' });

  getNotifHour().then(h =>
    console.log(`⚽ [ProdeNotif] Cron registrado: todos los días a las ${String(h).padStart(2,'0')}:00hs (configurable en Configurar → Hora de reportes)`)
  );
}

module.exports = { startProdeNotificationsJob, runProdeNotifications, buildDailyProdeMessage };