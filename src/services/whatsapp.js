const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');

let client = null;
let isReady = false;
let currentQR = null;

function getCurrentQR() { return currentQR; }
function getWhatsAppStatus() { return { connected: isReady }; }

// Normalizar número argentino
function normalizePhone(phoneNumber) {
  let clean = phoneNumber.replace(/\D/g, '');
  if (clean.startsWith('0')) clean = clean.substring(1);
  if (clean.startsWith('1115')) clean = '11' + clean.substring(4);
  let full = clean.startsWith('54') ? clean : `54${clean}`;
  if (full.startsWith('54') && !full.startsWith('549')) full = '549' + full.substring(2);
  return full;
}

function initWhatsApp() {
  client = new Client({
    authStrategy: new LocalAuth({ dataPath: './whatsapp-session' }),
    puppeteer: {
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
  });

  client.on('qr', (qr) => {
    currentQR = qr;
    console.log('\n📱 QR generado — escanealo en /api/whatsapp/qr-view\n');
    qrcode.generate(qr, { small: true });
  });

  client.on('ready', () => {
    isReady = true;
    currentQR = null;
    console.log('✅ WhatsApp conectado y listo');
  });

  client.on('disconnected', (reason) => {
    isReady = false;
    console.log('⚠️ WhatsApp desconectado:', reason);
    setTimeout(initWhatsApp, 5000);
  });

  client.on('auth_failure', () => {
    isReady = false;
    console.log('❌ Error de autenticación WhatsApp');
  });

  client.initialize().catch(err => {
    console.error('❌ Error iniciando WhatsApp:', err.message);
  });
}

initWhatsApp();

async function sendMessage(phoneNumber, message) {
  if (!isReady || !client) return { success: false, reason: 'WhatsApp no conectado' };
  try {
    const fullPhone = normalizePhone(phoneNumber);
    const chatId = `${fullPhone}@c.us`;
    const isRegistered = await client.isRegisteredUser(chatId);
    if (!isRegistered) return { success: false, reason: 'Número no registrado en WhatsApp' };
    await client.sendMessage(chatId, message);
    console.log(`✅ WA enviado a ${fullPhone}`);
    return { success: true };
  } catch (error) {
    console.error('❌ Error enviando WhatsApp:', error.message);
    return { success: false, error: error.message };
  }
}

// ── Mensaje 1: Al recibir el pedido (automático, inmediato) ────────────────
async function sendOrderReceived(phoneNumber, orderNumber, clientName, publicCode) {
  const displayCode = publicCode || orderNumber;
  const message =
    `¡Hola ${clientName}! 👋\n\n` +
    `Recibimos tu pedido *${displayCode}* ✅\n\n` +
    `En breve te confirmamos cuando la cocina lo apruebe.\n\n` +
    `_Janz Burgers_ 🍔`;
  return sendMessage(phoneNumber, message);
}

// ── Mensaje 2: Al confirmar (con desglose completo) ────────────────────────
async function sendOrderConfirmation(phoneNumber, orderNumber, clientName, total, items, paymentMethod, couponCode, discountAmount, transferAlias, publicCode, confirmedMinutes) {
  const displayCode = publicCode || orderNumber;
  const fmt = n => `$${Number(n || 0).toLocaleString('es-AR')}`;

  // Desglose de items con adicionales
  const itemLines = items.map(item => {
    let line = `  • *${item.productName} ${item.variant}* ×${item.quantity} — ${fmt(item.unitPrice * item.quantity)}`;
    if (item.additionals?.length) {
      item.additionals.forEach(a => {
        line += `\n      ↳ ${a.name} ×${a.quantity || 1} — ${fmt(a.unitPrice * (a.quantity || 1))}`;
      });
    }
    if (item.notes) line += `\n      📝 _${item.notes}_`;
    return line;
  }).join('\n');

  // Cupón
  const couponLine = couponCode && discountAmount > 0
    ? `\n🎟️ Cupón *${couponCode}*: -${fmt(discountAmount)}`
    : '';

  // Instrucción de pago
  let paymentLine = '';
  if (paymentMethod === 'efectivo') {
    paymentLine = `\n💵 *Tené listo ${fmt(total)} en efectivo* para el delivery.`;
  } else if (paymentMethod === 'transferencia') {
    const aliasText = transferAlias ? `\nAlias: *${transferAlias}*` : '';
    paymentLine = `\n🏦 *Enviá el comprobante de ${fmt(total)} por este chat.*${aliasText}`;
  }

  // Tiempo estimado confirmado por cocina
  const timeLine = confirmedMinutes
    ? `\n⏱️ *Tiempo estimado: ${confirmedMinutes} minutos.*`
    : '';

  const message =
    `¡Hola ${clientName}! 🔥\n\n` +
    `Tu pedido *${displayCode}* fue *confirmado por la cocina* y ya está en preparación.\n${timeLine}\n\n` +
    `*Detalle del pedido:*\n${itemLines}${couponLine}\n\n` +
    `💰 *Total: ${fmt(total)}*\n` +
    `${paymentLine}\n\n` +
    `_Janz Burgers_ 🍔`;

  return sendMessage(phoneNumber, message);
}

// ── Mensaje 3: Al estar listo / en camino ─────────────────────────────────
async function sendOrderReady(phoneNumber, orderNumber, clientName, deliveryType, total, paymentMethod, transferAlias, publicCode) {
  const displayCode = publicCode || orderNumber;
  const fmt = n => `$${Number(n || 0).toLocaleString('es-AR')}`;

  let paymentReminder = '';
  if (paymentMethod === 'efectivo') {
    paymentReminder = `\n💵 Recordá tener *${fmt(total)} en efectivo*.`;
  } else if (paymentMethod === 'transferencia') {
    const aliasText = transferAlias ? ` al alias *${transferAlias}*` : '';
    paymentReminder = `\n🏦 Si no enviaste el comprobante, transferí *${fmt(total)}*${aliasText} por este chat.`;
  }

  const message = deliveryType === 'takeaway'
    ? `¡Hola ${clientName}! 🥡\n\nTu pedido *${displayCode}* está *listo para retirar*. ✅\n\nPodés pasar a buscarlo. ¡Te esperamos!\n${paymentReminder}\n\n_Janz Burgers_ 🍔`
    : `¡Hola ${clientName}! 🛵\n\nTu pedido *${displayCode}* está *en camino*. ✅\n\nEn instantes llega a tu puerta.\n${paymentReminder}\n\n_Janz Burgers_ 🍔`;

  return sendMessage(phoneNumber, message);
}


// ── Mensaje 4: Pedido cancelado por falta de stock ────────────────────────
async function sendOrderCancelled(phoneNumber, clientName, publicCode, orderNumber) {
  const displayCode = publicCode || orderNumber;
  const message =
    `¡Hola ${clientName}! 😔

` +
    `Te avisamos que tu pedido *${displayCode}* fue cancelado porque en este momento no contamos con stock suficiente para prepararlo.

` +
    `Disculpá las molestias. Podés volver a pedir en nuestra próxima jornada.

` +
    `_Janz Burgers_ 🍔`;
  return sendMessage(phoneNumber, message);
}

module.exports = {
  sendMessage,
  sendOrderReceived,
  sendOrderCancelled,
  sendOrderConfirmation,
  sendOrderReady,
  getWhatsAppStatus,
  getCurrentQR
};
