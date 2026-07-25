require('dotenv').config();
const express = require('express');
const compression = require('compression');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const mongoose = require('mongoose');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const { initWhatsApp, getCurrentQR, getWhatsAppStatus } = require('./services/whatsapp');

// ── Validación de variables de entorno requeridas ────────────────────────────
const REQUIRED_ENV = ['MONGODB_URI', 'JWT_SECRET', 'FRONTEND_URL'];
const missingEnv = REQUIRED_ENV.filter(k => !process.env[k]);
if (missingEnv.length > 0) {
  console.error(`❌ Variables de entorno requeridas no configuradas: ${missingEnv.join(', ')}`);
  console.error('   Configurarlas en Railway → Variables antes de volver a deployar.');
  process.exit(1);
}

// ── Captura de errores no manejados ─────────────────────────────────────────
process.on('unhandledRejection', (reason) => {
  console.error('❌ [unhandledRejection] Promise rechazada sin manejar:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('❌ [uncaughtException] Excepción no capturada:', err);
  process.exit(1);
});

const app = express();

// FIX: Railway corre detrás de proxy — sin esto el rate limiter toma la IP
// del proxy como IP de todos los clientes (limitando de forma global).
app.set('trust proxy', 1);

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    methods: ['GET', 'POST']
  }
});

app.set('io', io);

io.on('connection', (socket) => {
  console.log('🔌 Socket conectado:', socket.id);
  socket.on('track_order', (orderNumber) => {
    socket.join(`order_${orderNumber}`);
    console.log(`📦 Cliente siguiendo pedido: ${orderNumber}`);
  });
  socket.on('disconnect', () => {
    console.log('🔌 Socket desconectado:', socket.id);
  });
});

// ── Seguridad ─────────────────────────────────────────────────────────────────
app.disable('x-powered-by'); // no exponer que es Express

// Comprime todas las respuestas (gzip/brotli según soporte del cliente).
// Antes el JSON de /api/public/menu, /api/products, etc. viajaba sin
// comprimir; esto reduce ese peso entre 60% y 80% sin tocar el contenido
// de las respuestas.
app.use(compression());

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"], // necesario para React en prod
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https://res.cloudinary.com'],
      connectSrc: ["'self'", process.env.FRONTEND_URL || ''],
      frameSrc: ["'none'"],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: [],
    },
  },
  crossOriginEmbedderPolicy: false,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));

const publicLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { message: 'Demasiadas solicitudes. Intentá en unos minutos.' },
  standardHeaders: true, legacyHeaders: false,
});
const orderLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  message: { message: 'Límite de pedidos alcanzado. Esperá unos minutos.' },
});

// Middleware
// FIX: FRONTEND_URL.split() crasheaba si la variable no estaba seteada.
// Ahora validada arriba en REQUIRED_ENV; aquí solo normalizamos.
const allowedOrigins = process.env.FRONTEND_URL.split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Database — fail fast: si Mongo no conecta al boot Railway lo detecta y reporta el error
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB conectado'))
  .catch(err => {
    console.error('❌ No se pudo conectar a MongoDB:', err.message);
    process.exit(1);
  });

// ── Registrar modelos de Push (necesario para que Mongoose los reconozca) ─────
require('./models/PushModels');
require('./models/Review');
require('./models/PinVerification');

const slotsRouter             = require('./routes/slots');
const whatsappTemplatesRouter = require('./routes/whatsapp-templates');
const pushRouter              = require('./routes/push');

// Routes existentes
app.use('/api/auth',            require('./routes/auth'));
app.use('/api/ingredients',     require('./routes/ingredients'));
app.use('/api/products',        require('./routes/products'));
app.use('/api/orders',          require('./routes/orders'));
app.use('/api/stock',           require('./routes/stock'));
app.use('/api/clients',         require('./routes/clients'));
app.use('/api/dashboard',       require('./routes/dashboard'));
app.use('/api/shopping',        require('./routes/shopping'));
app.use('/api/additionals',     require('./routes/additionals'));
app.use('/api/promos',          require('./routes/promos'));
app.use('/api/coupons',         require('./routes/coupons'));
app.use('/api/config',          require('./routes/config'));
app.use('/api/upload',          require('./routes/upload'));
app.use('/api/finance',         require('./routes/finance'));
app.use('/api/analytics',       require('./routes/analytics'));
app.use('/api/churn-job',       require('./routes/churn-job'));
app.use('/api/rejected-orders', require('./routes/rejected-orders'));
app.use('/api/expenses',        require('./routes/expenses'));

app.use('/api/cash-movements',  require('./routes/cash-movements'));

// /api/public — primero el router principal, luego los slots
// Ambos se montan en /api/public — Express los procesa en orden,
// el primero que matchee la ruta responde.
app.use('/api/public', publicLimiter);
app.use('/api/public/order', orderLimiter);
app.use('/api/public', require('./routes/public'));
app.use('/api/public', require('./routes/slots'));     // agrega /api/public/slots-availability

// Nuevas rutas
app.use('/api/whatsapp-templates', require('./routes/whatsapp-templates'));
app.use('/api/push',               require('./routes/push'));
app.use('/api/broadcast',          require('./routes/broadcast'));
app.use('/api/reviews',            require('./routes/reviews'));

// ── Jobs automáticos ──────────────────────────────────────────────────────────
const { startChurnJob }                = require('./jobs/churn-alert');
const { startBirthdayJob }             = require('./jobs/birthday-coupons');
const { startKitchenAlertJob }         = require('./jobs/kitchen-alert');
mongoose.connection.once('open', async () => {
  startChurnJob().catch(err => console.error('❌ Error iniciando churn job:', err.message));
  startKitchenAlertJob();
  startBirthdayJob();
});

// ── WhatsApp: status, initiate bajo demanda, y QR ────────────────────────────
const { auth, adminOnly } = require('./middleware/auth');

// GET estado actual de WhatsApp (conectado / desconectado / tiene QR listo)
app.get('/api/whatsapp/status', auth, adminOnly, (req, res) => {
  const { connected, initiated } = getWhatsAppStatus();
  const hasQR = !!getCurrentQR();
  res.json({ connected, hasQR, initiated });
});

// POST iniciar WhatsApp bajo demanda — genera el proceso y el QR
// Solo admin puede disparar esto. Evita que actores externos inicien sesiones.
// Si no se escanea el QR dentro del timeout (ver whatsapp.js), se apaga solo
// y hay que volver a llamar a este endpoint para reintentar.
app.post('/api/whatsapp/initiate', auth, adminOnly, (req, res) => {
  const { initiated } = getWhatsAppStatus();
  if (initiated) {
    return res.json({ ok: true, alreadyInitiated: true });
  }
  initWhatsApp();
  const backendUrl = (process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 5000}`);
  res.json({ ok: true, qrViewUrl: `${backendUrl}/api/whatsapp/qr-view` });
});

// GET QR como imagen base64 (para polling desde el frontend)
app.get('/api/whatsapp/qr', auth, adminOnly, async (req, res) => {
  const qr = getCurrentQR();
  if (!qr) return res.json({ qr: null, message: 'QR no disponible aún' });
  const qrImage = await QRCode.toDataURL(qr);
  res.json({ qr: qrImage });
});

// GET QR como página HTML (para abrir en nueva tab y escanear con el teléfono)
app.get('/api/whatsapp/qr-view', auth, adminOnly, async (req, res) => {
  const qr = getCurrentQR();
  if (!qr) {
    return res.send(`<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Janz Burgers — WhatsApp QR</title><meta http-equiv="refresh" content="5"><style>body{background:#0a0a0a;color:white;font-family:Inter,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center;padding:20px}.spinner{width:48px;height:48px;border:4px solid #333;border-top-color:#E8B84B;border-radius:50%;animation:spin 0.8s linear infinite;margin-bottom:24px}@keyframes spin{to{transform:rotate(360deg)}}h2{font-size:1.4rem;color:#E8B84B;margin-bottom:8px}p{color:#888;font-size:0.9rem}</style></head><body><div class="spinner"></div><h2>Iniciando WhatsApp...</h2><p>Esta página se actualiza sola cada 5 segundos.</p></body></html>`);
  }
  const qrImage = await QRCode.toDataURL(qr, { width: 400, margin: 2 });
  res.send(`<html><head><meta charset="utf-8"><title>Janz Burgers — Escanear QR</title><style>body{background:#0a0a0a;color:white;font-family:Inter,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center;padding:20px}h1{font-size:2rem;color:#E8B84B;margin-bottom:6px}p{color:#888;font-size:0.9rem;margin-bottom:24px}.qr-wrap{background:white;padding:20px;border-radius:16px;display:inline-block}img{display:block;width:300px;height:300px}.note{margin-top:20px;color:#555;font-size:0.8rem}</style></head><body><h1>JANZ BURGERS</h1><p>Escaneá este QR con WhatsApp para vincular el número</p><div class="qr-wrap"><img src="${qrImage}" alt="WhatsApp QR"/></div><p class="note">El QR expira en ~20 segundos. Si venció, recargá la página.</p></body></html>`);
});

app.get('/api/health', (req, res) => {
  const mongoOk = mongoose.connection.readyState === 1;
  const { connected: waOk } = getWhatsAppStatus();
  res.status(mongoOk ? 200 : 503).json({
    status: mongoOk ? 'ok' : 'degraded',
    mongo: mongoOk ? 'connected' : 'disconnected',
    whatsapp: waOk ? 'connected' : 'disconnected',
    uptime: Math.floor(process.uptime()),
  });
});

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ message: 'Error interno del servidor', error: err.message });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
});