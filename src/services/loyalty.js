const Config = require('../models/Config');
const Coupon = require('../models/Coupon');
const { Client } = require('../models/Order');
const { sendOrderReceived } = require('./whatsapp');

// Obtener config de fidelización
async function getLoyaltyConfig() {
  const cfg = await Config.findOne({ key: 'loyalty' });
  return cfg?.value || { enabled: false, pointsPerPeso: 1, redeemThreshold: 500, couponPercent: 10 };
}

// Obtener config de referidos (desde loyalty o campo separado)
async function getReferralConfig() {
  const cfg = await Config.findOne({ key: 'loyalty' });
  const loyalty = cfg?.value || {};
  return {
    enabled: loyalty.referralEnabled ?? false,
    rewardPercent: loyalty.referralRewardPercent ?? 5,
    discountForNew: loyalty.referralDiscountForNew ?? 10
  };
}

// Sumar puntos a un cliente al completar un pedido entregado
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

  // Verificar si supera umbral para generar cupón automático
  if (client.loyaltyPoints >= loyalty.redeemThreshold) {
    return await generateLoyaltyCoupon(client, loyalty);
  }

  return { pointsAdded: pointsToAdd, totalPoints: client.loyaltyPoints, couponGenerated: false };
}

// Generar cupón automático por fidelización
async function generateLoyaltyCoupon(client, loyalty) {
  try {
    const code = `JANZ-${client.name.split(' ')[0].toUpperCase().replace(/[^A-Z]/g, '')}-${Math.floor(Math.random() * 900) + 100}`;

    // Verificar que no exista
    const existing = await Coupon.findOne({ code });
    if (existing) return { pointsAdded: 0, totalPoints: client.loyaltyPoints, couponGenerated: false };

    const coupon = new Coupon({
      code,
      owner: client._id,
      ownerName: client.name,
      discountForUser: loyalty.couponPercent,
      rewardPerUse: 0,
      type: 'loyalty' // marca que es de fidelización
    });
    await coupon.save();

    // Descontar puntos usados (guardar excedente)
    const usedPoints = loyalty.redeemThreshold;
    await Client.findByIdAndUpdate(client._id, {
      $inc: { loyaltyPoints: -usedPoints }
    });

    // WhatsApp automático al cliente
    if (client.whatsapp) {
      const msg =
        `🎉 ¡Felicitaciones ${client.name}!\n\n` +
        `Acumulaste suficientes puntos y ganaste un cupón de *${loyalty.couponPercent}% de descuento*.\n\n` +
        `Tu código: *${code}*\n\n` +
        `Usalo en tu próximo pedido desde nuestra página. ¡Gracias por elegirnos! 🍔\n\n` +
        `_Janz Burgers_ 🔥`;
      sendMessage(client.whatsapp, msg).catch(e => console.error('WA fidelización:', e.message));
    }

    return { pointsAdded: 0, totalPoints: client.loyaltyPoints - usedPoints, couponGenerated: true, couponCode: code };
  } catch (err) {
    console.error('Error generando cupón fidelización:', err.message);
    return { couponGenerated: false };
  }
}

// Notificar al cliente estrella cuando alguien usa su cupón de referido
async function notifyReferralOwner(coupon, newClientName, orderTotal) {
  const referralCfg = await getReferralConfig();
  if (!referralCfg.enabled) return;

  try {
    const owner = await Client.findById(coupon.owner);
    if (!owner?.whatsapp) return;

    const fmt = n => `$${Number(n || 0).toLocaleString('es-AR')}`;
    const reward = Math.round(orderTotal * referralCfg.rewardPercent / 100);
    const msg =
      `🌟 ¡Buenas noticias ${owner.name}!\n\n` +
      `*${newClientName}* acaba de hacer su primer pedido usando tu cupón *${coupon.code}*.\n\n` +
      `Tu crédito acumulado aumentó: *${fmt(reward)}*\n\n` +
      `¡Gracias por recomendarnos! 🍔\n\n` +
      `_Janz Burgers_ 🔥`;

    sendMessage(owner.whatsapp, msg).catch(e => console.error('WA referido:', e.message));
  } catch (err) {
    console.error('Error notificando referido:', err.message);
  }
}

// Helper para enviar WA
async function sendMessage(phone, message) {
  try {
    const { sendMessage: waSend } = require('./whatsapp');
    return await waSend(phone, message);
  } catch (err) {
    console.error('[WA Fidelización] Error:', err.message);
  }
}

// Obtener clientes cerca del umbral de canje
async function getClientsNearThreshold() {
  const loyalty = await getLoyaltyConfig();
  if (!loyalty.enabled) return [];
  const threshold = loyalty.redeemThreshold;
  const warningLevel = threshold * 0.7; // 70% del umbral
  return Client.find({
    loyaltyPoints: { $gte: warningLevel },
    active: true
  }).sort('-loyaltyPoints').limit(20);
}

module.exports = { getLoyaltyConfig, getReferralConfig, addPointsForOrder, notifyReferralOwner, getClientsNearThreshold };
