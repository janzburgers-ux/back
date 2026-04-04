const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const Config = require('../models/Config');

let client = null;
let isReady = false;
let currentQR = null;

function getCurrentQR() { return currentQR; }
function getWhatsAppStatus() { return { connected: isReady }; }

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

  client.on('ready', () => { isReady = true; currentQR = null; console.log('✅ WhatsApp conectado y listo'); });
  client.on('disconnected', (reason) => { isReady = false; console.log('⚠️ WhatsApp desconectado:', reason); setTimeout(initWhatsApp, 5000); });
  client.on('auth_failure', () => { isReady = false; console.log('❌ Error de autenticación WhatsApp'); });
  client.initialize().catch(err => console.error('❌ Error iniciando WhatsApp:', err.message));
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

// ── Helpers ───────────────────────────────────────────────────────────────────
const fmt = n => `$${Number(n || 0).toLocaleString('es-AR')}`;

// Obtener template de DB o usar default
async function getTemplate(key, defaultTemplate) {
  try {
    const cfg = await Config.findOne({ key: 'whatsappTemplates' });
    return cfg?.value?.[key] || defaultTemplate;
  } catch {
    return defaultTemplate;
  }
}

// Reemplazar variables en un template
function fillTemplate(template, vars) {
  return Object.entries(vars).reduce((msg, [key, val]) => msg.replace(new RegExp(`\\{${key}\\}`, 'g'), val ?? ''), template);
}

// ── Mensaje 1: Al recibir el pedido ──────────────────────────────────────────
async function sendOrderReceived(phoneNumber, orderNumber, clientName, publicCode) {
  const displayCode = publicCode || orderNumber;
  const defaultTpl = `¡Hola {nombre}! 👋\n\nRecibimos tu pedido *{codigo}* ✅\n\nEn breve te confirmamos cuando la cocina lo apruebe.\n\n_Janz Burgers_ 🍔`;
  const tpl = await getTemplate('orderReceived', defaultTpl);
  const message = fillTemplate(tpl, { nombre: clientName, codigo: displayCode });
  return sendMessage(phoneNumber, message);
}

// ── Mensaje 2: Al confirmar ───────────────────────────────────────────────────
async function sendOrderConfirmation(phoneNumber, orderNumber, clientName, total, items, paymentMethod, couponCode, discountAmount, transferAlias, publicCode, confirmedMinutes) {
  const displayCode = publicCode || orderNumber;

  const itemLines = items.map(item => {
    let line = `  • *${item.productName} ${item.variant}* ×${item.quantity} — ${fmt(item.unitPrice * item.quantity)}`;
    if (item.additionals?.length) item.additionals.forEach(a => { line += `\n      ↳ ${a.name} ×${a.quantity || 1} — ${fmt(a.unitPrice * (a.quantity || 1))}`; });
    if (item.notes) line += `\n      📝 _${item.notes}_`;
    return line;
  }).join('\n');

  const couponLine = couponCode && discountAmount > 0 ? `\n🎟️ Cupón *${couponCode}*: -${fmt(discountAmount)}` : '';
  let paymentLine = '';
  if (paymentMethod === 'efectivo') paymentLine = `\n💵 *Tené listo ${fmt(total)} en efectivo* para el delivery.`;
  else if (paymentMethod === 'transferencia') paymentLine = `\n🏦 *Enviá el comprobante de ${fmt(total)} por este chat.*${transferAlias ? `\nAlias: *${transferAlias}*` : ''}`;
  const timeLine = confirmedMinutes ? `\n⏱️ *Tiempo estimado: ${confirmedMinutes} minutos.*` : '';

  const defaultTpl = `¡Hola {nombre}! 🔥\n\nTu pedido *{codigo}* fue *confirmado por la cocina* y ya está en preparación.{tiempoEstimado}\n\n*Detalle del pedido:*\n{items}{descuento}\n\n💰 *Total: {total}*\n{metodoPago}\n\n_Janz Burgers_ 🍔`;
  const tpl = await getTemplate('orderConfirmed', defaultTpl);
  const message = fillTemplate(tpl, {
    nombre: clientName, codigo: displayCode, total: fmt(total),
    items: itemLines, descuento: couponLine, metodoPago: paymentLine,
    alias: transferAlias || '', tiempoEstimado: timeLine
  });
  return sendMessage(phoneNumber, message);
}

// ── Mensaje 3: Listo / en camino ─────────────────────────────────────────────
async function sendOrderReady(phoneNumber, orderNumber, clientName, deliveryType, total, paymentMethod, transferAlias, publicCode) {
  const displayCode = publicCode || orderNumber;

  let paymentReminder = '';
  if (paymentMethod === 'efectivo') paymentReminder = `\n💵 Recordá tener *${fmt(total)} en efectivo*.`;
  else if (paymentMethod === 'transferencia') paymentReminder = `\n🏦 Si no enviaste el comprobante, transferí *${fmt(total)}*${transferAlias ? ` al alias *${transferAlias}*` : ''} por este chat.`;

  const defaultTplDelivery  = `¡Hola {nombre}! 🛵\n\nTu pedido *{codigo}* está *en camino*. ✅\n\nEn instantes llega a tu puerta.\n{metodoPago}\n\n_Janz Burgers_ 🍔`;
  const defaultTplTakeaway  = `¡Hola {nombre}! 🥡\n\nTu pedido *{codigo}* está *listo para retirar*. ✅\n\nPodés pasar a buscarlo. ¡Te esperamos!\n{metodoPago}\n\n_Janz Burgers_ 🍔`;

  const tpl = await getTemplate('orderReady', deliveryType === 'takeaway' ? defaultTplTakeaway : defaultTplDelivery);
  const message = fillTemplate(tpl, {
    nombre: clientName, codigo: displayCode, total: fmt(total),
    metodoPago: paymentReminder, alias: transferAlias || '', tipoEntrega: deliveryType
  });
  return sendMessage(phoneNumber, message);
}

// ── Mensaje 4: Cancelado ──────────────────────────────────────────────────────
async function sendOrderCancelled(phoneNumber, clientName, publicCode, orderNumber) {
  const displayCode = publicCode || orderNumber;
  const defaultTpl = `¡Hola {nombre}! 😔\n\nTe avisamos que tu pedido *{codigo}* fue cancelado porque en este momento no contamos con stock suficiente para prepararlo.\n\nDisculpá las molestias. Podés volver a pedir en nuestra próxima jornada.\n\n_Janz Burgers_ 🍔`;
  const tpl = await getTemplate('orderCancelled', defaultTpl);
  const message = fillTemplate(tpl, { nombre: clientName, codigo: displayCode });
  return sendMessage(phoneNumber, message);
}

module.exports = { sendMessage, sendOrderReceived, sendOrderCancelled, sendOrderConfirmation, sendOrderReady, getWhatsAppStatus, getCurrentQR };
