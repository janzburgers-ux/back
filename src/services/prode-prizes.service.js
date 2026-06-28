// ── Sistema de Premios Automáticos para Prode Janz ────────────────────────────
// Reutiliza el sistema de cupones existente (no es un sistema de recompensas
// aparte). Genera y entrega automáticamente los premios de los primeros 3
// puestos del ranking del Prode, usando WhatsApp para el aviso.
const Coupon     = require('../models/Coupon');
const ProdePrize = require('../models/ProdePrize');
const { Client }  = require('../models/Order');
const { sendMessage } = require('./whatsapp');
const { getTop3Competidores } = require('./prode.service');

const SEASON = process.env.PRODE_SEASON || `mundial-${new Date().getFullYear()}`;

// ── Generar código de cupón JANZ-style para premios Prode ─────────────────────
function generatePrizeCode(prefix) {
  const CHARS  = 'ABCDEFGHJKMNPQRSTUVWXYZ';
  const DIGITS = '23456789';
  const suffix =
    CHARS[Math.floor(Math.random() * CHARS.length)] +
    CHARS[Math.floor(Math.random() * CHARS.length)] +
    DIGITS[Math.floor(Math.random() * DIGITS.length)] +
    DIGITS[Math.floor(Math.random() * DIGITS.length)];
  return `PRODE-${prefix}-${suffix}`;
}

function friendlyName(client) {
  return client?.nickname || client?.name?.split(' ')[0] || 'Crack';
}

// ── Crea el documento Coupon real (reutiliza el sistema existente) ────────────
async function createPrizeCoupon({ code, client, discountForUser = 100, maxUses = null }) {
  const coupon = new Coupon({
    code,
    owner:              client._id,
    ownerName:          client.name,
    type:               'prode',
    discountForUser,
    applicableVariant:  'doble',
    rewardPerUse:       0,
    unlimited:          false,
    singleUse:          !maxUses,     // si no hay maxUses, es de 1 solo uso global
    maxUses:            maxUses || null,
    ownerOnly:          true,         // solo el ganador puede usarlo
    active:             true,
  });
  await coupon.save();
  return coupon;
}

// ── Envía el aviso de WhatsApp para un cupón de premio ─────────────────────────
async function sendPrizeMessage(client, { code, title, body }) {
  if (!client.whatsapp) return false;
  const friendly = friendlyName(client);
  const msg =
    `🏆 ¡${title}, ${friendly}!\n\n` +
    `${body}\n\n` +
    `🎟️ Tu código: *${code}*\n\n` +
    `Canjealo en tu próximo pedido eligiendo cualquier hamburguesa *doble* — queda 100% gratis. ` +
    `Sólo lo podés usar vos, con el mismo WhatsApp con el que jugaste el Prode.\n\n` +
    `_Janz Burgers_ 🍔⚽`;
  try {
    await sendMessage(client.whatsapp, msg);
    return true;
  } catch (err) {
    console.error('❌ [ProdePrizes] Error enviando WhatsApp:', err.message);
    return false;
  }
}

// ── 1er puesto: 4 cupones semanales (1 inmediato + 3 programados) ────────────
async function awardFirstPlace(client, totalPoints) {
  const now = new Date();
  const weeks = [
    { label: 'W1', offsetDays: 0 },
    { label: 'W2', offsetDays: 7 },
    { label: 'W3', offsetDays: 14 },
    { label: 'W4', offsetDays: 21 },
  ].map(w => ({
    label:  w.label,
    sendAt: new Date(now.getTime() + w.offsetDays * 24 * 60 * 60 * 1000),
    sent:   false,
    sentAt: null,
    couponCode: null,
    coupon: null,
  }));

  const prize = await ProdePrize.create({
    position:   1,
    client:     client._id,
    clientName: client.name,
    prizeLabel: '4 semanas de Janz gratis (1 hamburguesa doble por semana)',
    season:     SEASON,
    weeks,
    totalPointsAtAward: totalPoints || 0,
  });

  // Semana 1 se entrega ahora mismo
  await deliverWeek(prize, 0);
  return prize;
}

// ── 2do puesto: 1 cupón con maxUses:2 ─────────────────────────────────────────
async function awardSecondPlace(client, totalPoints) {
  const code = generatePrizeCode('SEGUNDO');
  const coupon = await createPrizeCoupon({ code, client, maxUses: 2 });

  const prize = await ProdePrize.create({
    position:   2,
    client:     client._id,
    clientName: client.name,
    prizeLabel: '2 hamburguesas dobles a elección',
    season:     SEASON,
    weeks: [{
      label: 'UNICO', sendAt: new Date(), sent: false, sentAt: null,
      couponCode: code, coupon: coupon._id,
    }],
    totalPointsAtAward: totalPoints || 0,
  });

  const ok = await sendPrizeMessage(client, {
    code,
    title: 'Saliste 2do en el Prode',
    body: 'Ganaste *2 hamburguesas dobles* a elección. Usá el mismo código las 2 veces — al segundo uso queda agotado.',
  });
  prize.weeks[0].sent = ok;
  prize.weeks[0].sentAt = ok ? new Date() : null;
  await prize.save();
  return prize;
}

// ── 3er puesto: 1 cupón de un solo uso ────────────────────────────────────────
async function awardThirdPlace(client, totalPoints) {
  const code = generatePrizeCode('TERCERO');
  const coupon = await createPrizeCoupon({ code, client });

  const prize = await ProdePrize.create({
    position:   3,
    client:     client._id,
    clientName: client.name,
    prizeLabel: '1 hamburguesa doble a elección',
    season:     SEASON,
    weeks: [{
      label: 'UNICO', sendAt: new Date(), sent: false, sentAt: null,
      couponCode: code, coupon: coupon._id,
    }],
    totalPointsAtAward: totalPoints || 0,
  });

  const ok = await sendPrizeMessage(client, {
    code,
    title: 'Saliste 3ro en el Prode',
    body: 'Ganaste *1 hamburguesa doble* a elección, totalmente gratis.',
  });
  prize.weeks[0].sent = ok;
  prize.weeks[0].sentAt = ok ? new Date() : null;
  await prize.save();
  return prize;
}

// ── Entrega (genera cupón + manda WA) la semana `idx` de un premio de 1er puesto ──
async function deliverWeek(prize, idx) {
  const week = prize.weeks[idx];
  if (!week || week.sent) return prize;

  const client = await Client.findById(prize.client);
  if (!client) {
    week.error = 'Cliente no encontrado';
    await prize.save();
    return prize;
  }

  try {
    const code = generatePrizeCode(week.label);
    const coupon = await createPrizeCoupon({ code, client });
    week.couponCode = code;
    week.coupon = coupon._id;

    const weekNum = idx + 1;
    const ok = await sendPrizeMessage(client, {
      code,
      title: weekNum === 1 ? '¡Ganaste el Prode! 1er puesto' : `Semana ${weekNum} de tu premio`,
      body: weekNum === 1
        ? 'Ganaste *4 semanas de Janz gratis* 🎉 — 1 hamburguesa doble por semana, durante 4 semanas. Esta es la primera, las próximas 3 te las vamos a ir mandando automáticamente.'
        : `Te llegó la hamburguesa doble gratis de la semana ${weekNum} de tu premio del Prode.`,
    });

    week.sent = ok;
    week.sentAt = ok ? new Date() : null;
    week.error = ok ? null : 'Falló el envío de WhatsApp (revisar conexión)';
  } catch (err) {
    week.error = err.message;
    console.error('❌ [ProdePrizes] Error entregando semana:', err.message);
  }

  await prize.save();
  return prize;
}

// ── Job diario: revisa premios de 1er puesto con semanas pendientes ──────────
async function processPendingScheduledSends() {
  const now = new Date();
  const pending = await ProdePrize.find({
    position: 1,
    season: SEASON,
    weeks: { $elemMatch: { sent: false, sendAt: { $lte: now } } },
  });

  let delivered = 0;
  for (const prize of pending) {
    for (let i = 0; i < prize.weeks.length; i++) {
      const w = prize.weeks[i];
      if (!w.sent && new Date(w.sendAt) <= now) {
        await deliverWeek(prize, i);
        delivered++;
      }
    }
  }
  return { checked: pending.length, delivered };
}

// ── Punto de entrada: finaliza el Prode y premia al top 3 ────────────────────
// Idempotente: si ya existe un premio para una posición en esta temporada, lo saltea.
async function awardTop3Prizes() {
  const top3 = await getTop3Competidores();
  if (!top3 || top3.length === 0) {
    return { awarded: [], skipped: [], message: 'No hay competidores elegibles para el top 3 todavía.' };
  }

  const awarded = [];
  const skipped = [];

  for (let i = 0; i < Math.min(3, top3.length); i++) {
    const position = i + 1;
    const entry = top3[i];

    const already = await ProdePrize.findOne({ position, season: SEASON });
    if (already) {
      skipped.push({ position, reason: 'Ya fue premiado en esta temporada', clientName: already.clientName });
      continue;
    }

    const client = await Client.findById(entry.clientId);
    if (!client) {
      skipped.push({ position, reason: 'Cliente no encontrado', clientId: entry.clientId });
      continue;
    }

    let prize;
    if (position === 1) prize = await awardFirstPlace(client, entry.totalPuntos);
    else if (position === 2) prize = await awardSecondPlace(client, entry.totalPuntos);
    else prize = await awardThirdPlace(client, entry.totalPuntos);

    awarded.push({ position, clientName: client.name, prizeLabel: prize.prizeLabel });
  }

  return { awarded, skipped };
}

// ── Auditoría: lista de premios entregados (para el panel admin) ─────────────
async function listPrizes() {
  return ProdePrize.find({ season: SEASON }).sort({ position: 1 }).lean();
}

module.exports = {
  awardTop3Prizes,
  processPendingScheduledSends,
  listPrizes,
  SEASON,
};
