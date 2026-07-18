const mongoose = require('mongoose');

// Client schema
const clientSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  phone: { type: String, trim: true },
  whatsapp: { type: String, trim: true },
  email: { type: String, trim: true, lowercase: true },
  address: { type: String },
  floor: { type: String },
  neighborhood: { type: String },
  references: { type: String },
  notes: { type: String },
  nickname: { type: String, trim: true },          // apodo para mensajes WA
  birthDay: { type: Number, min: 1, max: 31 },     // día de cumpleaños
  birthMonth: { type: Number, min: 1, max: 12 },   // mes de cumpleaños
  birthSkipped: { type: Boolean, default: false },  // eligió no dar cumple → no volver a preguntar
  totalOrders: { type: Number, default: 0 },
  totalSpent: { type: Number, default: 0 },
  loyaltyPoints: { type: Number, default: 0 },
  totalPointsEarned: { type: Number, default: 0 },
  active: { type: Boolean, default: true },
  // isTestClient: pedidos de este cliente no cuentan en reportes ni analytics
  isTestClient: { type: Boolean, default: false },
  // Difusión masiva: si true, este cliente no recibe mensajes de broadcast
  broadcastOptOut: { type: Boolean, default: false },
  // Prode Mundial
  prodeRegisteredAt:    { type: Date, default: null },
  prodeGuestCouponCode: { type: String, default: null, trim: true },
}, { timestamps: true });

// FIX rendimiento: whatsapp es la clave de búsqueda en cada pedido, PIN y notificación
clientSchema.index({ whatsapp: 1 });
clientSchema.index({ active: 1, whatsapp: 1 });

const orderItemAdditionalSchema = new mongoose.Schema({
  additional: { type: mongoose.Schema.Types.ObjectId, ref: 'Additional', required: true },
  name: { type: String },
  unitPrice: { type: Number, required: true },
  quantity: { type: Number, default: 1 }
}, { _id: false });

const orderItemSchema = new mongoose.Schema({
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  productName: { type: String },
  variant: { type: String },
  quantity: { type: Number, required: true, default: 1 },
  unitPrice: { type: Number, required: true },
  additionals: [orderItemAdditionalSchema],
  subtotal: { type: Number },
  notes: { type: String }
}, { _id: false });

const orderSchema = new mongoose.Schema({
  orderNumber: { type: String, unique: true },
  publicCode:  { type: String },
  client: { type: mongoose.Schema.Types.ObjectId, ref: 'Client', required: true },
  items: [orderItemSchema],
  additionals: { type: Number, default: 0 },
  total: { type: Number, default: 0 },
  status: {
    type: String,
    enum: ['pending', 'confirmed', 'preparing', 'ready', 'delivered', 'cancelled'],
    default: 'pending'
  },
  paymentMethod: {
    type: String,
    enum: ['efectivo', 'transferencia'],
    default: 'efectivo'
  },
  deliveryType: {
    type: String,
    enum: ['local', 'delivery', 'takeaway'],
    default: 'local'
  },
  deliveryAddress: { type: String },
  notes: { type: String },
  coupon: { type: mongoose.Schema.Types.ObjectId, ref: 'Coupon', default: null },
  couponCode: { type: String, default: null },
  // ── Trazabilidad de cupones rechazados ───────────────────────────────────
  // Si el cliente intentó un cupón pero terminó no aplicándose (por
  // ownerOnly, maxUses, ya usado, etc.), queda registrado acá en vez de
  // perderse en silencio. couponCode queda null (no se aplicó ningún
  // descuento), pero couponAttempted guarda qué código escribió el cliente.
  couponAttempted: { type: String, default: null },
  couponRejectionReason: { type: String, default: null },
  discountAmount: { type: Number, default: 0 },
  discountPercent: { type: Number, default: 0 },
  // 'order' = descuento sobre todo el pedido | 'product' = descuento sobre producto específico
  discountType: { type: String, enum: ['order', 'product', 'variant'], default: 'order' },
  stockDeducted: { type: Boolean, default: false },
  whatsappSent: { type: Boolean, default: false },

  // Tiempos
  estimatedMinutes: { type: Number, default: null },
  confirmedMinutes: { type: Number, default: null },
  deliveryMinutes:  { type: Number, default: null },
  receivedAt: { type: Date },
  confirmedAt: { type: Date },
  preparingAt: { type: Date },
  cookingStartedAt: { type: Date },  // inicio real del timer (al pasar a preparing)
  kitchenAlertSentAt: { type: Date }, // Fase 5: cuando se mandó la alerta de WA a cocina
  readyAt: { type: Date },
  deliveredAt: { type: Date },

  // Programación
  scheduledFor: { type: Date, default: null },
  isScheduled: { type: Boolean, default: false },
  estimatedReadyAt: { type: Date, default: null },
  estimatedDeliveryAt: { type: Date, default: null },

  // Zona y packaging
  zone: { type: String },
  deliveryCost: { type: Number, default: 0 },
  packagingCost: { type: Number, default: 0 },

  // Anti-duplicados: clave única generada en el frontend por sesión de checkout.
  // Si el cliente reintenta el envío (corte de internet, doble tap), el backend
  // detecta el key repetido y devuelve el pedido ya creado sin duplicar.
  idempotencyKey: { type: String, default: null, index: true, sparse: true }
}, { timestamps: true });

// ── Índices ──────────────────────────────────────────────────────────────
// Estas dos consultas se repiten en varias rutas (listado de pedidos en el
// panel admin, conteo diario para el límite de pedidos en /public/menu) y
// hoy no tenían ningún índice que las respalde más allá del _id: Mongo
// terminaba escaneando toda la colección. Sin índices esto no se nota
// con pocos pedidos, pero se va a poner cada vez más lento a medida que
// crece el historial.
orderSchema.index({ status: 1, createdAt: -1 });
orderSchema.index({ createdAt: -1 });
// FIX rendimiento: índices para countDeliveredInPeriod (ranking Prode) y analytics
orderSchema.index({ client: 1, status: 1, deliveredAt: -1 });
orderSchema.index({ deliveredAt: -1 });

function generatePublicCode() {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return `jz-${code}`;
}

orderSchema.pre('save', async function(next) {
  if (this.isNew) {
    // FIX race condition orderNumber: el patron leer-ultimo+sumar-1 no es atomico.
    // Dos pedidos simultaneos pueden leer el mismo ultimo numero y generar el mismo
    // siguiente, rompiendo con E11000 (unique). Counter con $inc es atomico en Mongo.
    const { getNextSequence } = require('./Counter');
    const nextNum = await getNextSequence('orderNumber');
    this.orderNumber = `JANZ-${String(nextNum).padStart(4, '0')}`;
    this.publicCode = generatePublicCode();
    this.receivedAt = new Date();
  }

  // Calcular subtotales de ítems
  let subtotal = 0;
  this.items.forEach(item => {
    const additionalsTotal = (item.additionals || []).reduce(
      (s, a) => s + (a.unitPrice * (a.quantity || 1)), 0
    );
    item.subtotal = (item.unitPrice * item.quantity) + additionalsTotal;
    subtotal += item.subtotal;
  });
  subtotal += (this.additionals || 0);

  // Descuento:
  // - discountType === 'product' | 'variant': discountAmount fue pre-calculado, no recalcular
  // - discountType === 'order': calcular desde discountPercent sobre todo el subtotal
  if (this.discountType !== 'product' && this.discountType !== 'variant' && this.discountPercent > 0) {
    this.discountAmount = Math.round(subtotal * this.discountPercent / 100);
  }

  this.total = Math.max(0, subtotal - (this.discountAmount || 0) + (this.deliveryCost || 0));

  next();
});

const Client = mongoose.model('Client', clientSchema);
const Order = mongoose.model('Order', orderSchema);

module.exports = { Client, Order };