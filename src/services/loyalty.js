const Config = require('../models/Config');
const Coupon = require('../models/Coupon');
const { Client, Order } = require('../models/Order');

// ── Config helpers ─────────────────────────────────────────────────────────────
async function getLoyaltyConfig() {
  const cfg = await Config.findOne({ key: 'loyalty' });
  return cfg?.value || { enabled: false, pointsPerPeso: 1, redeemThreshold: 500, couponPercent: 10 };
}

async function getReferralConfig() {
  const cfg = await Config.findOne({ key: 'loyalty' });
  const loyalty = cfg?.value || {};
  return {
    enabled:          loyalty.referralEnabled      ?? false,
    rewardPercent:    loyalty.referralRewardPercent ?? 5,
    discountForNew:   loyalty.referralDiscountForNew ?? 10,
  };
}

// ── Calcular ticket promedio del dueño del cupón ────────────────────────────────
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
  // Mismo whatsapp = el dueño intentó usar su propio cupón
  if (owner.whatsapp && clientWhatsapp && owner.whatsapp === clientWhatsapp) {
    // Registrar intento
    await Coupon.findByIdAndUpdate(coupon._id, {
      $push: { fraudFlags: { reason: `Dueño intentó usar su propio cupón (WA: ${clientWhatsapp})` } }
    });
    return true;
  }
  return false;
}

// ── Registrar uso PENDIENTE al hacer el pedido ─────────────────────────────────
// Se llama cuando el nuevo cliente confirma el pedido (antes de entrega)
async function registerReferralUse(couponId, clientId, clientName, clientWhatsapp, orderId, orderNumber, orderTotal, discountApplied) {
  const coupon = await Coupon.findById(couponId);
  if (!coupon || coupon.type !== 'referral') return;

  const alreadyRecorded = coupon.uses.some(u => u.order?.toString() === orderId.toString());
  if (alreadyRecorded) return;

  await Coupon.findByIdAndUpdate(couponId, {
    $push: {
      uses: {
        client:        clientId,
        clientName,
        whatsapp:      clientWhatsapp,
        order:         orderId,
        orderNumber,
        orderTotal,
        discountApplied,
        status:        'pending',
        usedAt:        new Date()
      }
    },
    $inc: { totalUses: 1 }
  });
}

// ── Validar uso al entregar el pedido ─────────────────────────────────────────
// Se llama cuando el pedido pasa a 'delivered'
// Aquí es donde realmente se acumula la recompensa del dueño
async function validateReferralUse(orderId) {
  const coupon = await Coupon.findOne({ 'uses.order': orderId, type: 'referral' });
  if (!coupon) return null;

  const useIndex = coupon.uses.findIndex(u => u.order?.toString() === orderId.toString());
  if (useIndex === -1) return null;
  const use = coupon.uses[useIndex];
  if (use.status === 'validated') return null; // ya validado

  const referralCfg = await getReferralConfig();
  const rewardPercent = coupon.rewardPerUse || referralCfg.rewardPercent || 5;

  // Acumular % para el dueño
  const newAccumulated = (coupon.ownerAccumulatedPercent || 0) + rewardPercent;

  // Actualizar el uso a 'validated' y acumular recompensa
  await Coupon.findOneAndUpdate(
    { _id: coupon._id, 'uses.order': orderId },
    {
      $set: {
        'uses.$.status':      'validated',
        'uses.$.validatedAt': new Date()
      },
      $inc: {
        validatedUses:          1,
        ownerAccumulatedPercent: rewardPercent
      }
    }
  );

  // Notificar al dueño por WhatsApp
  const updatedCoupon = await Coupon.findById(coupon._id);
  await notifyReferralOwner(updatedCoupon, use.clientName, use.orderTotal, newAccumulated);

  return { rewardPercent, newAccumulated, coupon: updatedCoupon };
}

// ── Notificar al dueño cuando alguien usa su cupón y el pedido fue entregado ───
async function notifyReferralOwner(coupon, newClientName, orderTotal, newAccumulated) {
  const referralCfg = await getReferralConfig();
  if (!referralCfg.enabled) return;

  try {
    const owner = await Client.findById(coupon.owner).select('name whatsapp');
    if (!owner?.whatsapp) return;

    const fmt = n => `$${Number(n || 0).toLocaleString('es-AR')}`;
    const rewardPercent = coupon.rewardPerUse || referralCfg.rewardPercent;
    const avgTicket = coupon.ownerAvgTicket || 0;
    const maxDiscount = avgTicket > 0 ? fmt(avgTicket) : 'tu promedio de compra';

    // Cuántos usos válidos lleva (para mostrar progreso)
    const validUses = coupon.validatedUses || 0;

    const msg =
      `🌟 ¡Buenas noticias ${owner.name}!\n\n` +
      `*${newClientName}* acaba de recibir su pedido usando tu código *${coupon.code}*. ✅\n\n` +
      `📈 Acumulaste *+${rewardPercent}%* de descuento.\n` +
      `💰 Total acumulado: *${newAccumulated}%* (${validUses} uso${validUses !== 1 ? 's' : ''} válido${validUses !== 1 ? 's' : ''})\n\n` +
      (avgTicket > 0 ? `🔒 Tu cupón tiene un tope de *${maxDiscount}* (tu ticket promedio).\n\n` : '') +
      `¿Qué querés hacer?\n` +
      `👉 *Seguir acumulando* — no hagas nada, seguimos contando\n` +
      `👉 *Canjear ahora* — respondé *CANJEAR* y te mandamos el cupón\n\n` +
      `_Janz Burgers_ 🍔`;

    await sendWA(owner.whatsapp, msg);
  } catch (err) {
    console.error('Error notificando referido:', err.message);
  }
}

// ── Canjear recompensa acumulada → generar cupón para el dueño ─────────────────
async function redeemReferralReward(couponId) {
  const coupon = await Coupon.findById(couponId).populate('owner');
  if (!coupon) throw new Error('Cupón no encontrado');
  if (!coupon.ownerAccumulatedPercent || coupon.ownerAccumulatedPercent <= 0) {
    throw new Error('No hay recompensa acumulada para canjear');
  }

  const owner = coupon.owner;
  const discountPercent = Math.min(coupon.ownerAccumulatedPercent, 100); // máximo 100%
  const avgTicket = coupon.ownerAvgTicket || (await calcOwnerAvgTicket(owner._id));
  const maxAmountCap = avgTicket; // tope = promedio de compra del dueño

  // Generar código único para el cupón de recompensa
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const suffix = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  const rewardCode = `REF-${owner.name.split(' ')[0].toUpperCase().replace(/[^A-Z]/g, '').slice(0, 6)}-${suffix}`;

  // Crear el cupón de recompensa (es de uso único para el dueño)
  const rewardCoupon = new Coupon({
    code:           rewardCode,
    owner:          owner._id,
    ownerName:      owner.name,
    type:           'loyalty',
    discountForUser: discountPercent,
    // Si tiene tope, guardar info como nota (el tope se aplica en el checkout)
    ownerAvgTicket: maxAmountCap,
    rewardPerUse:   0,
    unlimited:      false,
    singleUse:      true,
    active:         true,
    expiresAt:      new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 días
  });
  await rewardCoupon.save();

  // Resetear contador del cupón de referido
  await Coupon.findByIdAndUpdate(couponId, {
    $set:  { ownerAccumulatedPercent: 0 },
    $inc:  { ownerRedemptions: 1 }
  });

  // Notificar al dueño con el código
  if (owner.whatsapp) {
    const fmt = n => `$${Number(n || 0).toLocaleString('es-AR')}`;
    const msg =
      `🎉 ¡Aquí está tu recompensa ${owner.name}!\n\n` +
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

// ── WhatsApp a múltiples clientes seleccionados ────────────────────────────────
async function sendReferralInvitations(clientIds, message) {
  const clients = await Client.find({ _id: { $in: clientIds }, active: true }).select('name whatsapp');
  const results = [];
  for (const client of clients) {
    if (!client.whatsapp) { results.push({ name: client.name, status: 'sin_whatsapp' }); continue; }
    try {
      await sendWA(client.whatsapp, message.replace('{nombre}', client.name));
      results.push({ name: client.name, status: 'enviado' });
    } catch (e) {
      results.push({ name: client.name, status: 'error', error: e.message });
    }
    // Pequeño delay para no saturar WhatsApp
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
    const code = `JANZ-${client.name.split(' ')[0].toUpperCase().replace(/[^A-Z]/g, '')}-${Math.floor(Math.random() * 900) + 100}`;
    const existing = await Coupon.findOne({ code });
    if (existing) return { couponGenerated: false };
    const coupon = new Coupon({ code, owner: client._id, ownerName: client.name, discountForUser: loyalty.couponPercent, rewardPerUse: 0, type: 'loyalty' });
    await coupon.save();
    await Client.findByIdAndUpdate(client._id, { $inc: { loyaltyPoints: -loyalty.redeemThreshold } });
    if (client.whatsapp) {
      const msg = `🎉 ¡Felicitaciones ${client.name}!\n\nAcumulaste suficientes puntos y ganaste un cupón de *${loyalty.couponPercent}% de descuento*.\n\nTu código: *${code}*\n\nUsalo en tu próximo pedido. ¡Gracias por elegirnos! 🍔\n\n_Janz Burgers_ 🔥`;
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
  getLoyaltyConfig, getReferralConfig,
  addPointsForOrder,
  calcOwnerAvgTicket, isFraudAttempt,
  registerReferralUse, validateReferralUse,
  redeemReferralReward, sendReferralInvitations,
  notifyReferralOwner,
  getClientsNearThreshold
};
