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
  totalOrders: { type: Number, default: 0 },
  totalSpent: { type: Number, default: 0 },
  loyaltyPoints: { type: Number, default: 0 },
  totalPointsEarned: { type: Number, default: 0 },
  active: { type: Boolean, default: true }
}, { timestamps: true });

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
  discountAmount: { type: Number, default: 0 },
  discountPercent: { type: Number, default: 0 },
  // 'order' = descuento sobre todo el pedido | 'product' = descuento sobre producto específico
  discountType: { type: String, enum: ['order', 'product'], default: 'order' },
  stockDeducted: { type: Boolean, default: false },
  whatsappSent: { type: Boolean, default: false },

  // Tiempos
  estimatedMinutes: { type: Number, default: null },
  confirmedMinutes: { type: Number, default: null },
  deliveryMinutes:  { type: Number, default: null },
  receivedAt: { type: Date },
  confirmedAt: { type: Date },
  preparingAt: { type: Date },
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
  packagingCost: { type: Number, default: 0 }
}, { timestamps: true });

function generatePublicCode() {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return `jz-${code}`;
}

orderSchema.pre('save', async function(next) {
  if (this.isNew) {
    // Buscar el último pedido por orderNumber para evitar conflictos al borrar pedidos
    // (countDocuments() falla si se borró algún pedido porque puede repetir un número ya usado)
    const last = await mongoose.model('Order').findOne({}, { orderNumber: 1 }).sort({ createdAt: -1 });
    let nextNum = 1;
    if (last?.orderNumber) {
      const match = last.orderNumber.match(/(\d+)$/);
      if (match) nextNum = parseInt(match[1], 10) + 1;
    }
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
  // - discountType === 'product': discountAmount fue pre-calculado sobre el producto específico, no recalcular
  // - discountType === 'order': calcular desde discountPercent sobre todo el subtotal
  if (this.discountType !== 'product' && this.discountPercent > 0) {
    this.discountAmount = Math.round(subtotal * this.discountPercent / 100);
  }

  this.total = Math.max(0, subtotal - (this.discountAmount || 0) + (this.deliveryCost || 0));

  next();
});

const Client = mongoose.model('Client', clientSchema);
const Order = mongoose.model('Order', orderSchema);

module.exports = { Client, Order };