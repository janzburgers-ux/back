// ── WhatsApp Service ──────────────────────────────────────────────────────────
//
// FIX crítico "sesión WA se pierde en cada deploy":
// Railway tiene filesystem efímero — todo lo que se guarda en disco (incluida
// la sesión de LocalAuth en ./whatsapp-session/) desaparece en cada deploy,
// restart o scale-down. El resultado era que el backend quedaba sin sesión
// activa y no podía enviar ningún mensaje hasta que alguien escaneara el QR
// a mano. Con RemoteAuth + MongoStore, la sesión se guarda cifrada en la
// base de datos MongoDB (que sí persiste) y se restaura automáticamente al
// arrancar. Después del primer escaneo, nunca más hace falta hacerlo salvo
// que la sesión sea revocada desde el teléfono.

const { Client, RemoteAuth } = require('whatsapp-web.js');
const { MongoStore }         = require('wwebjs-mongo');
const mongoose               = require('mongoose');
const qrcode                 = require('qrcode-terminal');
const Config                 = require('../models/Config');

let client      = null;
let isReady     = false;
let currentQR   = null;
let reconnecting = false;

function getCurrentQR()      { return currentQR; }
function getWhatsAppStatus() { return { connected: isReady }; }

function normalizePhone(phoneNumber) {
  let clean = phoneNumber.replace(/\D/g, '');
  if (clean.startsWith('0'))    clean = clean.substring(1);
  if (clean.startsWith('1115')) clean = '11' + clean.substring(4);
  let full = clean.startsWith('54') ? clean : `54${clean}`;
  if (full.startsWith('54') && !full.startsWith('549')) full = '549' + full.substring(2);
  return full;
}

function buildClient() {
  // MongoStore usa la conexión de Mongoose que ya está abierta.
  // Requiere que initWhatsApp() sea llamado DESPUÉS de que MongoDB conecte.
  const store = new MongoStore({ mongoose });

  return new Client({
    authStrategy: new RemoteAuth({
      store,
      // Sincroniza la sesión a MongoDB cada 5 minutos (en vez de solo al cerrar).
      // Así, si el proceso muere abruptamente, no se pierde más de 5 min de estado.
      backupSyncIntervalMs: 5 * 60 * 1000,
    }),
    puppeteer: {
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',   // evita crash en contenedores con /dev/shm pequeño
        '--disable-gpu',
      ],
    },
  });
}

function initWhatsApp() {
  if (reconnecting) return;

  client = buildClient();

  client.on('qr', (qr) => {
    currentQR = qr;
    console.log('\n📱 QR generado — escanealo en /api/whatsapp/qr-view\n');
    qrcode.generate(qr, { small: true });
  });

  client.on('remote_session_saved', () => {
    console.log('💾 [WhatsApp] Sesión guardada en MongoDB correctamente.');
  });

  client.on('ready', () => {
    isReady      = true;
    currentQR    = null;
    reconnecting = false;
    console.log('✅ WhatsApp conectado y listo (sesión en MongoDB)');
  });

  client.on('authenticated', () => {
    console.log('🔐 [WhatsApp] Autenticado — sesión válida.');
  });

  client.on('auth_failure', (msg) => {
    isReady = false;
    console.error('❌ [WhatsApp] Error de autenticación:', msg);
    // No reintentar en auth_failure — el QR ya no es válido, necesita
    // que el admin abra /api/whatsapp/initiate de nuevo para generar uno nuevo.
  });

  client.on('disconnected', (reason) => {
    isReady      = false;
    reconnecting = true;
    console.warn(`⚠️ [WhatsApp] Desconectado: ${reason}. Reintentando en 10s...`);
    // Destruir el cliente anterior para liberar recursos de Puppeteer
    client.destroy().catch(() => {}).finally(() => {
      reconnecting = false;
      // Esperar 10 seg antes de reconectar para evitar bucles rápidos
      setTimeout(initWhatsApp, 10_000);
    });
  });

  client.initialize().catch(err => {
    console.error('❌ [WhatsApp] Error al inicializar:', err.message);
    reconnecting = false;
  });
}

// ── sendMessage ───────────────────────────────────────────────────────────────
async function sendMessage(phoneNumber, message) {
  if (!isReady || !client) {
    console.warn(`⚠️ [WhatsApp] Mensaje no enviado a ${phoneNumber}: cliente no listo`);
    return { success: false, reason: 'WhatsApp no conectado' };
  }
  try {
    const fullPhone = normalizePhone(phoneNumber);
    const chatId    = `${fullPhone}@c.us`;
    const isReg     = await client.isRegisteredUser(chatId);
    if (!isReg) return { success: false, reason: 'Número no registrado en WhatsApp' };
    await client.sendMessage(chatId, message);
    console.log(`✅ WA enviado a ${fullPhone}`);
    return { success: true };
  } catch (error) {
    console.error('❌ [WhatsApp] Error enviando mensaje:', error.message);
    return { success: false, error: error.message };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const fmt = n => `$${Number(n || 0).toLocaleString('es-AR')}`;

async function getTemplate(key, defaultTemplate) {
  try {
    const cfg = await Config.findOne({ key: 'whatsappTemplates' });
    return cfg?.value?.[key] || defaultTemplate;
  } catch {
    return defaultTemplate;
  }
}

function fillTemplate(template, vars) {
  return Object.entries(vars).reduce(
    (msg, [key, val]) => msg.replace(new RegExp(`\\{${key}\\}`, 'g'), val ?? ''),
    template
  );
}

// ── Mensaje 1: Al recibir el pedido ──────────────────────────────────────────
async function sendOrderReceived(phoneNumber, orderNumber, clientName, publicCode) {
  const displayCode = publicCode || orderNumber;
  const defaultTpl  = `¡Hola {nombre}! 👋\n\nRecibimos tu pedido *{codigo}* ✅\n\nEn breve te confirmamos cuando la cocina lo apruebe.\n\n_Janz Burgers_ 🍔`;
  const tpl         = await getTemplate('orderReceived', defaultTpl);
  return sendMessage(phoneNumber, fillTemplate(tpl, { nombre: clientName, codigo: displayCode }));
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

  const couponLine  = couponCode && discountAmount > 0 ? `\n🎟️ Cupón *${couponCode}*: -${fmt(discountAmount)}` : '';
  let paymentLine   = '';
  if (paymentMethod === 'efectivo')       paymentLine = `\n💵 *Tené listo ${fmt(total)} en efectivo* para el delivery.`;
  else if (paymentMethod === 'transferencia') paymentLine = `\n🏦 *Enviá el comprobante de ${fmt(total)} por este chat.*${transferAlias ? `\nAlias: *${transferAlias}*` : ''}`;
  const timeLine    = confirmedMinutes ? `\n⏱️ *Tiempo estimado: ${confirmedMinutes} minutos.*` : '';

  const defaultTpl  = `¡Hola {nombre}! 🔥\n\nTu pedido *{codigo}* fue *confirmado por la cocina* y ya está en preparación.{tiempoEstimado}\n\n*Detalle del pedido:*\n{items}{descuento}\n\n💰 *Total: {total}*\n{metodoPago}\n\n_Janz Burgers_ 🍔`;
  const tpl         = await getTemplate('orderConfirmed', defaultTpl);
  return sendMessage(phoneNumber, fillTemplate(tpl, {
    nombre: clientName, codigo: displayCode, total: fmt(total),
    items: itemLines, descuento: couponLine, metodoPago: paymentLine,
    alias: transferAlias || '', tiempoEstimado: timeLine,
  }));
}

// ── Mensaje 3: Listo / en camino ─────────────────────────────────────────────
async function sendOrderReady(phoneNumber, orderNumber, clientName, deliveryType, total, paymentMethod, transferAlias, publicCode) {
  const displayCode = publicCode || orderNumber;

  let paymentReminder = '';
  if (paymentMethod === 'efectivo')       paymentReminder = `\n💵 Recordá tener *${fmt(total)} en efectivo*.`;
  else if (paymentMethod === 'transferencia') paymentReminder = `\n🏦 Si no enviaste el comprobante, transferí *${fmt(total)}*${transferAlias ? ` al alias *${transferAlias}*` : ''} por este chat.`;

  const defaultTplDelivery = `¡Hola {nombre}! 🛵\n\nTu pedido *{codigo}* está *en camino*. ✅\n\nEn instantes llega a tu puerta.\n{metodoPago}\n\n_Janz Burgers_ 🍔`;
  const defaultTplTakeaway = `¡Hola {nombre}! 🥡\n\nTu pedido *{codigo}* está *listo para retirar*. ✅\n\nPodés pasar a buscarlo. ¡Te esperamos!\n{metodoPago}\n\n_Janz Burgers_ 🍔`;

  let tpl;
  if (deliveryType === 'takeaway') {
    tpl = await getTemplate('orderReady_takeaway', defaultTplTakeaway);
  } else {
    const cfg      = await Config.findOne({ key: 'whatsappTemplates' });
    const savedNew = cfg?.value?.['orderReady_delivery'];
    const savedOld = cfg?.value?.['orderReady'];
    tpl = savedNew || savedOld || defaultTplDelivery;
  }

  return sendMessage(phoneNumber, fillTemplate(tpl, {
    nombre: clientName, codigo: displayCode, total: fmt(total),
    metodoPago: paymentReminder, alias: transferAlias || '', tipoEntrega: deliveryType,
  }));
}

// ── Mensaje 4: Cancelado ──────────────────────────────────────────────────────
async function sendOrderCancelled(phoneNumber, clientName, publicCode, orderNumber) {
  const displayCode = publicCode || orderNumber;
  const defaultTpl  = `¡Hola {nombre}! 😔\n\nTe avisamos que tu pedido *{codigo}* fue cancelado porque en este momento no contamos con stock suficiente para prepararlo.\n\nDisculpá las molestias. Podés volver a pedir en nuestra próxima jornada.\n\n_Janz Burgers_ 🍔`;
  const tpl         = await getTemplate('orderCancelled', defaultTpl);
  return sendMessage(phoneNumber, fillTemplate(tpl, { nombre: clientName, codigo: displayCode }));
}

// ── Mensaje 5: Cancelado con cupón de disculpa ────────────────────────────────
async function sendOrderCancelledWithCoupon(phoneNumber, clientName, publicCode, couponCode) {
  const defaultTpl =
    `¡Hola {nombre}! 😔\n\n` +
    `Lamentamos informarte que tu pedido *{codigo}* fue cancelado porque nos quedamos sin stock.\n\n` +
    `Para disculparnos, te regalamos un *10% de descuento* en tu próximo pedido:\n\n` +
    `🎟️ Código: *{cupon}*\n\n` +
    `Válido por 15 días, un solo uso. ¡Te esperamos pronto!\n\n` +
    `_Janz Burgers_ 🍔`;
  const tpl = await getTemplate('orderCancelledStock', defaultTpl);
  return sendMessage(phoneNumber, fillTemplate(tpl, { nombre: clientName, codigo: publicCode, cupon: couponCode }));
}

// ── Mensaje 6: Solicitud de reseña (post-entrega) ─────────────────────────────
async function sendReviewRequest(phoneNumber, clientName, publicCode, frontendUrl) {
  const baseUrl    = frontendUrl || (process.env.FRONTEND_URL || 'https://janzburgers.vercel.app').split(',')[0].trim();
  const reviewUrl  = `${baseUrl}/resena/${publicCode}`;
  const defaultTpl = `¡Hola {nombre}! 🍔\n\n¿Cómo estuvo tu pedido de hoy?\n\nContanos qué te pareció y *te regalamos algo para la próxima* 🎁\n\n👉 {link}\n\n¡Solo tarda 30 segundos!\n\n_Janz Burgers_ 🍔`;
  const tpl        = await getTemplate('reviewRequest', defaultTpl);
  return sendMessage(phoneNumber, fillTemplate(tpl, { nombre: clientName, link: reviewUrl, codigo: publicCode }));
}

module.exports = {
  initWhatsApp,
  sendMessage,
  sendOrderReceived,
  sendOrderConfirmation,
  sendOrderReady,
  sendOrderCancelled,
  sendOrderCancelledWithCoupon,
  sendReviewRequest,
  getWhatsAppStatus,
  getCurrentQR,
};
