const mongoose = require('mongoose');

const couponSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true, trim: true, uppercase: true },

  // Cliente dueño del cupón (referido)
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'Client', required: true },
  ownerName: { type: String },

  // Tipo de cupón
  // 'referral'  → cupón de referido (cliente recomienda a otro)
  // 'admin'     → cupón genérico creado por admin (uso ilimitado)
  // 'loyalty'   → cupón de fidelización (1 uso, lo genera el sistema)
  // 'product'   → descuento sobre una hamburguesa específica
  type: { type: String, enum: ['referral', 'admin', 'loyalty', 'product'], default: 'referral' },

  // ── Descuento ─────────────────────────────────────────────────────────────
  // discountForUser: % de descuento que recibe quien usa el cupón
  discountForUser: { type: Number, default: 10 },

  // Producto específico al que aplica el descuento (null = todo el pedido)
  applicableProduct: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },
  applicableProductName: { type: String, default: null }, // cache legible

  // ── Recompensa para el dueño del cupón ────────────────────────────────────
  rewardPerUse: { type: Number, default: 5 },
  ownerPendingDiscount: { type: Number, default: 0 },

  // ── Historial de usos ─────────────────────────────────────────────────────
  uses: [{
    client: { type: mongoose.Schema.Types.ObjectId, ref: 'Client' },
    clientName: { type: String },
    whatsapp: { type: String },
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
    orderNumber: { type: String },
    discountApplied: { type: Number },
    usedAt: { type: Date, default: Date.now }
  }],
  totalUses: { type: Number, default: 0 },

  // ── Opciones ──────────────────────────────────────────────────────────────
  unlimited: { type: Boolean, default: false },
  singleUse: { type: Boolean, default: false }, // 1 uso total en total
  active: { type: Boolean, default: true },

  // Validez
  expiresAt: { type: Date, default: null }
}, { timestamps: true });

// Código siempre en mayúsculas
couponSchema.pre('save', function(next) {
  this.code = this.code.toUpperCase();
  next();
});

module.exports = mongoose.model('Coupon', couponSchema);
