const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const http = require('http');
const { Server } = require('socket.io');
require('dotenv').config();
const QRCode = require('qrcode');
const { getCurrentQR } = require('./services/whatsapp');

const app = express();
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

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL.split(','),
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Database
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/janzburgers')
  .then(() => console.log('✅ MongoDB conectado'))
  .catch(err => console.error('❌ Error MongoDB:', err));

// ── Registrar modelos de Push (necesario para que Mongoose los reconozca) ─────
require('./models/PushModels');

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
app.use('/api/coupons',         require('./routes/coupons'));
app.use('/api/config',          require('./routes/config'));
app.use('/api/upload',          require('./routes/upload'));
app.use('/api/finance',         require('./routes/finance'));
app.use('/api/analytics',       require('./routes/analytics'));
app.use('/api/churn-job',       require('./routes/churn-job'));
app.use('/api/rejected-orders', require('./routes/rejected-orders'));
app.use('/api/expenses',        require('./routes/expenses'));
app.use('/api/prode',           require('./routes/prode'));
app.use('/api/cash-movements',  require('./routes/cash-movements'));

// /api/public — primero el router principal, luego los slots
// Ambos se montan en /api/public — Express los procesa en orden,
// el primero que matchee la ruta responde.
app.use('/api/public', require('./routes/public'));
app.use('/api/public', require('./routes/slots'));     // agrega /api/public/slots-availability

// Nuevas rutas
app.use('/api/whatsapp-templates', require('./routes/whatsapp-templates'));
app.use('/api/push',               require('./routes/push'));

// ── Jobs automáticos ──────────────────────────────────────────────────────────
const { startChurnJob } = require('./jobs/churn-alert');
mongoose.connection.once('open', () => {
  startChurnJob().catch(err => console.error('❌ Error iniciando churn job:', err.message));
});

app.get('/api/whatsapp/qr', async (req, res) => {
  const qr = getCurrentQR();
  if (!qr) return res.json({ message: 'QR no disponible aún' });
  const qrImage = await QRCode.toDataURL(qr);
  res.json({ qr: qrImage });
});

app.get('/api/whatsapp/qr-view', async (req, res) => {
  const qr = getCurrentQR();
  if (!qr) {
    return res.send(`<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Janz Burgers — WhatsApp QR</title><meta http-equiv="refresh" content="5"><style>body{background:#0a0a0a;color:white;font-family:Inter,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center;padding:20px}.spinner{width:48px;height:48px;border:4px solid #333;border-top-color:#E8B84B;border-radius:50%;animation:spin 0.8s linear infinite;margin-bottom:24px}@keyframes spin{to{transform:rotate(360deg)}}h2{font-size:1.4rem;color:#E8B84B;margin-bottom:8px}p{color:#888;font-size:0.9rem}</style></head><body><div class="spinner"></div><h2>Iniciando WhatsApp...</h2><p>Esta página se actualiza sola cada 5 segundos.</p></body></html>`);
  }
  const qrImage = await QRCode.toDataURL(qr, { width: 400, margin: 2 });
  res.send(`<html><head><meta charset="utf-8"><title>Janz Burgers — Escanear QR</title><style>body{background:#0a0a0a;color:white;font-family:Inter,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center;padding:20px}h1{font-size:2rem;color:#E8B84B;margin-bottom:6px}p{color:#888;font-size:0.9rem;margin-bottom:24px}.qr-wrap{background:white;padding:20px;border-radius:16px;display:inline-block}img{display:block;width:300px;height:300px}.note{margin-top:20px;color:#555;font-size:0.8rem}</style></head><body><h1>🍔 JANZ BURGERS</h1><p>Escaneá este QR con WhatsApp para vincular el número</p><div class="qr-wrap"><img src="${qrImage}" alt="WhatsApp QR"/></div><p class="note">El QR expira en ~20 segundos. Si venció, recargá la página.</p></body></html>`);
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: '🍔 Janz Burgers API running' });
});

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ message: 'Error interno del servidor', error: err.message });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
});