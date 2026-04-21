const Config = require('../models/Config');
const Coupon = require('../models/Coupon');
const { Client, Order } = require('../models/Order');

// ── Generar código de cupón unificado JB-APODO-X9 ─────────────────────────────
// Min: las letras del apodo (sin relleno). Max: 8 chars. Sufijo: 1 letra + 1 dígito
function generateCouponCode(nickname) {
  const CHARS  = 'ABCDEFGHJKMNPQRSTUVWXYZ';
  const DIGITS = '23456789';
  const slug = (nickname || 'CLI')
    .toUpperCase()
    .replace(/[^A-Z]/g, '')
    .slice(0, 8);
  const suffix =
    CHARS[Math.floor(Math.random() * CHARS.length)] +
    DIGITS[Math.floor(Math.random() * DIGITS.length)];
  return `JB-${slug}-${suffix}`;
}
// "Gianfra"    → JB-GIANFRA-K7
// "Sol"        → JB-SOL-M3
// "Ro"         → JB-RO-A8
// "Maximiliano"→ JB-MAXIMILI-K7

// ── Nombre amistoso ───────────────────────────────────────────────────────────
function friendlyName(client) {
  return client?.nickname || client?.name?.split(' ')[0] || 'Cliente';
}

// ── Config helpers ─────────────────────────────────────────────────────────────
async function getLoyaltyConfig() {
  const cfg = await Config.findOne({ key: 'loyalty' });
  return cfg?.value || { enabled: false, pointsPerPeso: 1, redeemThreshold: 500, couponPercent: 10 };
}

async function getReferralConfig() {
  const cfg = await Config.findOne({ key: 'loyalty' });
  const loyalty = cfg?.value || {};
  return {
    enabled:        loyalty.referralEnabled       ?? false,
    rewardPercent:  loyalty.referralRewardPercent ?? 5,
    discountForNew: loyalty.referralDiscountForNew ?? 10,
  };
}

// ── Calcular ticket promedio del dueño del cupón ───────────────────────────────
async function calcOwnerAvgTicket(clientId) {
  const orders = await Order.find({ client: clientId, status: 'delivered' }).select('total');
  if (!orders.length) return 0;
  const total = orders.reduce((s, o) => s + o.total, 0);
  return Math.round(total / orders.length);
}

// ── Anti-fraude: verificar que el usuario que usa el cupón no sea el dueño ──────
async function isFraudAttempt(coupon, clientWhatsapp) {
  if (!coupon.blockedOwnerUse) return false;
  const owner = await Client.findById(coupon.owner).select('whatsapp');
  if (!owner) return false;
  if (owner.whatsapp && clientWhatsapp && owner.whatsapp === clientWhatsapp) {
    await Coupon.findByIdAndUpdate(coupon._id, {
      $push: { fraudFlags: { reason: `Dueño intentó usar su propio cupón (WA: ${clientWhatsapp})` } }
    });
    return true;
  }
  return false;
}

// ── Registrar uso PENDIENTE al hacer el pedido ─────────────────────────────────
async function registerReferralUse(couponId, clientId, clientName, clientWhatsapp, orderId, orderNumber, orderTotal, discountApplied) {
  const coupon = await Coupon.findById(couponId);
  if (!coupon || coupon.type !== 'referral') return;

  const alreadyRecorded = coupon.uses.some(u => u.order?.toString() === orderId.toString());
  if (alreadyRecorded) return;

  const usedBefore = coupon.uses.some(u => u.client?.toString() === clientId.toString());
  if (usedBefore) {
    console.log(`[Referido] Cupón ${coupon.code}: cliente ${clientName} ya usó este cupón antes — no cuenta`);
    return;
  }

  await Coupon.findByIdAndUpdate(couponId, {
    $push: {
      uses: {
        client: clientId, clientName, whatsapp: clientWhatsapp,
        order: orderId, orderNumber, orderTotal, discountApplied,
        status: 'pending', usedAt: new Date()
      }
    },
    $inc: { totalUses: 1 }
  });
}

// ── Validar uso al entregar el pedido ─────────────────────────────────────────
async function validateReferralUse(orderId) {
  const coupon = await Coupon.findOne({ 'uses.order': orderId, type: 'referral' });
  if (!coupon) return null;

  const useIndex = coupon.uses.findIndex(u => u.order?.toString() === orderId.toString());
  if (useIndex === -1) return null;
  const use = coupon.uses[useIndex];
  if (use.status === 'validated') return null;

  const referralCfg = await getReferralConfig();
  const rewardPercent = coupon.rewardPerUse || referralCfg.rewardPercent || 5;
  const newAccumulated = (coupon.ownerAccumulatedPercent || 0) + rewardPercent;

  await Coupon.findOneAndUpdate(
    { _id: coupon._id, 'uses.order': orderId },
    {
      $set: { 'uses.$.status': 'validated', 'uses.$.validatedAt': new Date() },
      $inc: { validatedUses: 1, ownerAccumulatedPercent: rewardPercent }
    }
  );

  const updatedCoupon = await Coupon.findById(coupon._id);
  await notifyReferralOwner(updatedCoupon, use.clientName, use.orderTotal, newAccumulated);

  return { rewardPercent, newAccumulated, coupon: updatedCoupon };
}

// ── Notificar al dueño cuando alguien usa su cupón ───────────────────────────
async function notifyReferralOwner(coupon, newClientName, orderTotal, newAccumulated) {
  const referralCfg = await getReferralConfig();
  if (!referralCfg.enabled) return;

  try {
    const owner = await Client.findById(coupon.owner).select('name nickname whatsapp');
    if (!owner?.whatsapp) return;

    const fmt = n => `$${Number(n || 0).toLocaleString('es-AR')}`;
    const friendly = friendlyName(owner);
    const rewardPercent = coupon.rewardPerUse || referralCfg.rewardPercent;
    const avgTicket = coupon.ownerAvgTicket || 0;
    const maxDiscount = avgTicket > 0 ? fmt(avgTicket) : 'tu promedio de compra';
    const validUses = coupon.validatedUses || 0;

    const msg =
      `🌟 ¡Buenas noticias ${friendly}!\n\n` +
      `*${newClientName}* acaba de recibir su pedido usando tu código *${coupon.code}*. ✅\n\n` +
      `📈 Acumulaste *+${rewardPercent}%* de descuento.\n` +
      `💰 Total acumulado: *${newAccumulated}%* (${validUses} uso${validUses !== 1 ? 's' : ''} válido${validUses !== 1 ? 's' : ''})\n\n` +
      (avgTicket > 0 ? `🔒 Tu cupón tiene un tope de *${maxDiscount}* (tu ticket promedio).\n\n` : '') +
      `¿Qué querés hacer?\n` +
      `👉 *Seguir acumulando* — no hagas nada, seguimos contando\n` +
      `👉 *Canjear ahora* — avisanos y te mandamos el cupón\n\n` +
      `_Janz Burgers_ 🍔`;

    await sendWA(owner.whatsapp, msg);
  } catch (err) {
    console.error('Error notificando referido:', err.message);
  }
}

// ── Canjear recompensa acumulada → generar cupón para el dueño ────────────────
async function redeemReferralReward(couponId) {
  const coupon = await Coupon.findById(couponId).populate('owner');
  if (!coupon) throw new Error('Cupón no encontrado');
  if (!coupon.ownerAccumulatedPercent || coupon.ownerAccumulatedPercent <= 0) {
    throw new Error('No hay recompensa acumulada para canjear');
  }

  const owner = coupon.owner;
  const discountPercent = Math.min(coupon.ownerAccumulatedPercent, 100);
  const avgTicket = coupon.ownerAvgTicket || (await calcOwnerAvgTicket(owner._id));
  const maxAmountCap = avgTicket;
  const friendly = friendlyName(owner);

  const rewardCode = generateCouponCode(owner.nickname || owner.name?.split(' ')[0] || 'CLI');

  const rewardCoupon = new Coupon({
    code:            rewardCode,
    owner:           owner._id,
    ownerName:       owner.name,
    type:            'loyalty',
    discountForUser: discountPercent,
    ownerAvgTicket:  maxAmountCap,
    rewardPerUse:    0,
    unlimited:       false,
    singleUse:       true,
    active:          true,
    expiresAt:       new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  });
  await rewardCoupon.save();

  await Coupon.findByIdAndUpdate(couponId, {
    $set: { ownerAccumulatedPercent: 0 },
    $inc: { ownerRedemptions: 1 }
  });

  if (owner.whatsapp) {
    const fmt = n => `$${Number(n || 0).toLocaleString('es-AR')}`;
    const msg =
      `🎉 ¡Aquí está tu recompensa ${friendly}!\n\n` +
      `Generamos tu cupón de *${discountPercent}% de descuento*.\n` +
      (maxAmountCap > 0 ? `🔒 Tope máximo: *${fmt(maxAmountCap)}* de descuento.\n` : '') +
      `\n🎟️ Tu código: *${rewardCode}*\n\n` +
      `Usalo en tu próximo pedido. Válido por 30 días.\n` +
      `Tu contador de referidos vuelve a *0%* y empezás de nuevo. 🚀\n\n` +
      `_Janz Burgers_ 🍔`;
    await sendWA(owner.whatsapp, msg);
  }

  return { rewardCode, discountPercent, maxAmountCap };
}

// ── WA a múltiples clientes (invitaciones referido) ───────────────────────────
async function sendReferralInvitations(clientIds, message) {
  const clients = await Client.find({ _id: { $in: clientIds }, active: true }).select('name nickname whatsapp');
  const results = [];
  for (const client of clients) {
    if (!client.whatsapp) { results.push({ name: client.name, status: 'sin_whatsapp' }); continue; }
    try {
      const msg = message.replace('{nombre}', friendlyName(client));
      await sendWA(client.whatsapp, msg);
      results.push({ name: client.name, status: 'enviado' });
    } catch (e) {
      results.push({ name: client.name, status: 'error', error: e.message });
    }
    await new Promise(r => setTimeout(r, 800));
  }
  return results;
}

// ── Helpers ────────────────────────────────────────────────────────────────────
async function sendWA(phone, message) {
  const { sendMessage } = require('./whatsapp');
  return sendMessage(phone, message);
}

async function addPointsForOrder(clientId, orderTotal) {
  const loyalty = await getLoyaltyConfig();
  if (!loyalty.enabled) return null;
  const pointsToAdd = Math.floor(orderTotal / loyalty.pointsPerPeso);
  if (pointsToAdd <= 0) return null;
  const client = await Client.findByIdAndUpdate(
    clientId,
    { $inc: { loyaltyPoints: pointsToAdd, totalPointsEarned: pointsToAdd } },
    { new: true }
  );
  if (client.loyaltyPoints >= loyalty.redeemThreshold) {
    return await generateLoyaltyCoupon(client, loyalty);
  }
  return { pointsAdded: pointsToAdd, totalPoints: client.loyaltyPoints, couponGenerated: false };
}

async function generateLoyaltyCoupon(client, loyalty) {
  try {
    const code = generateCouponCode(client.nickname || client.name?.split(' ')[0] || 'CLI');
    const existing = await Coupon.findOne({ code });
    if (existing) return { couponGenerated: false };

    const coupon = new Coupon({
      code,
      owner:           client._id,
      ownerName:       client.name,
      discountForUser: loyalty.couponPercent,
      rewardPerUse:    0,
      type:            'loyalty',
      unlimited:       false,
      singleUse:       true,
      active:          true,
    });
    await coupon.save();
    await Client.findByIdAndUpdate(client._id, { $inc: { loyaltyPoints: -loyalty.redeemThreshold } });

    const friendly = friendlyName(client);
    if (client.whatsapp) {
      const msg =
        `🎉 ¡Felicitaciones ${friendly}!\n\n` +
        `Acumulaste suficientes puntos y ganaste un cupón de *${loyalty.couponPercent}% de descuento*.\n\n` +
        `🎟️ Tu código: *${code}*\n\n` +
        `Usalo en tu próximo pedido. ¡Gracias por elegirnos! 🍔\n\n` +
        `_Janz Burgers_ 🔥`;
      sendWA(client.whatsapp, msg).catch(e => console.error('WA fidelización:', e.message));
    }
    return { couponGenerated: true, couponCode: code };
  } catch (err) {
    console.error('Error generando cupón fidelización:', err.message);
    return { couponGenerated: false };
  }
}

async function getClientsNearThreshold() {
  const loyalty = await getLoyaltyConfig();
  if (!loyalty.enabled) return [];
  return Client.find({ loyaltyPoints: { $gte: loyalty.redeemThreshold * 0.7 }, active: true }).sort('-loyaltyPoints').limit(20);
}

module.exports = {
  generateCouponCode,
  friendlyName,
  getLoyaltyConfig, getReferralConfig,
  addPointsForOrder,
  calcOwnerAvgTicket, isFraudAttempt,
  registerReferralUse, validateReferralUse,
  redeemReferralReward, sendReferralInvitations,
  notifyReferralOwner,
  getClientsNearThreshold
};