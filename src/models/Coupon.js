const mongoose = require('mongoose');

const couponSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true, trim: true, uppercase: true },

  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'Client', required: true },
  ownerName: { type: String },

  // 'referral' | 'admin' | 'loyalty' | 'product' | 'prode'
  type: { type: String, enum: ['referral', 'admin', 'loyalty', 'product', 'reactivation', 'birthday', 'apology', 'prode'], default: 'referral' },
  // Restringe el cupón a una variante específica (ej: "doble"), sin importar el producto elegido.
  // Se puede combinar con applicableProduct (ej: "solo Doble Janz") o dejar solo,
  // sin producto, para que aplique a "cualquier doble" del menú.
  applicableVariant: { type: String, default: null },
  // Cuántas unidades de esa variante reciben el descuento (si el cliente pide más
  // cantidad de la que cubre el cupón, el resto se cobra a precio normal). Se eligen
  // siempre las unidades más baratas primero, para proteger el margen.
  variantQuantity: { type: Number, default: 1 },
  // Cantidad máxima de usos globales (distinto de singleUse: singleUse = 1 uso; maxUses = N usos).
  maxUses: { type: Number, default: null },
  // Restringe el uso del cupón a que el WhatsApp del pedido coincida con el del owner (premios Prode).
  ownerOnly: { type: Boolean, default: false },

  // Descuento para quien usa el cupón
  // 'percent' = % sobre el subtotal aplicable (discountForUser) | 'fixed' = monto $ fijo (fixedAmount)
  discountMode: { type: String, enum: ['percent', 'fixed'], default: 'percent' },
  discountForUser: { type: Number, default: 10 },
  // Monto $ fijo a descontar cuando discountMode === 'fixed'. Se topea al subtotal
  // aplicable (todo el pedido, o solo el producto si hay applicableProduct) — si el
  // cupón vale más que ese subtotal, el descuento queda en el subtotal completo (paga $0),
  // nunca deja el subtotal en negativo.
  fixedAmount: { type: Number, default: null },
  applicableProduct: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },
  applicableProductName: { type: String, default: null },

  // ── Recompensa acumulable para el dueño ────────────────────────────────────
  rewardPerUse: { type: Number, default: 5 },           // % que acumula por cada uso validado
  ownerAccumulatedPercent: { type: Number, default: 0 }, // % acumulado esperando canje
  ownerPendingDiscount: { type: Number, default: 0 },   // legacy / compatibilidad
  ownerAvgTicket: { type: Number, default: 0 },          // tope dinámico = promedio de compra del dueño
  ownerRedemptions: { type: Number, default: 0 },        // veces que ya canjeó

  // ── Historial de usos ─────────────────────────────────────────────────────
  uses: [{
    client: { type: mongoose.Schema.Types.ObjectId, ref: 'Client' },
    clientName: { type: String },
    whatsapp: { type: String },
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
    orderNumber: { type: String },
    orderTotal: { type: Number, default: 0 },
    discountApplied: { type: Number },
    // 'pending' = pedido hecho pero no entregado aún
    // 'validated' = pedido entregado — ESTE es el que cuenta
    status: { type: String, enum: ['pending', 'validated'], default: 'pending' },
    usedAt: { type: Date, default: Date.now },
    validatedAt: { type: Date, default: null }
  }],
  totalUses: { type: Number, default: 0 },         // todos (pending + validated)
  validatedUses: { type: Number, default: 0 },     // solo entregados

  // ── Anti-fraude ───────────────────────────────────────────────────────────
  blockedOwnerUse: { type: Boolean, default: true }, // bloquea que el dueño use su propio cupón
  fraudFlags: [{ reason: String, flaggedAt: { type: Date, default: Date.now } }],

  // ── Opciones ──────────────────────────────────────────────────────────────
  unlimited: { type: Boolean, default: true },
  singleUse: { type: Boolean, default: false },
  active: { type: Boolean, default: true },
  expiresAt: { type: Date, default: null }
}, { timestamps: true });

couponSchema.pre('save', function(next) {
  this.code = this.code.toUpperCase();
  next();
});

module.exports = mongoose.model('Coupon', couponSchema);