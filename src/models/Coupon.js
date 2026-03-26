const mongoose = require('mongoose');

const couponSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true, trim: true, uppercase: true },
  // Cliente estrella al que pertenece el cupón
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'Client', required: true },
  ownerName: { type: String }, // cache para mostrarlo fácil en el panel
  // Descuento que recibe quien usa el cupón (%)
  discountForUser: { type: Number, default: 10 },
  // Descuento acumulado para el dueño del cupón (% por cada uso)
  rewardPerUse: { type: Number, default: 5 }, // 5% por cada pedido referido
  // Descuento acumulado disponible para el dueño
  ownerPendingDiscount: { type: Number, default: 0 },
  // Historial de usos
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
  unlimited: { type: Boolean, default: false }, // cupones admin — sin límite de usos
  active: { type: Boolean, default: true }
}, { timestamps: true });

// Código siempre en mayúsculas
couponSchema.pre('save', function(next) {
  this.code = this.code.toUpperCase();
  next();
});

module.exports = mongoose.model('Coupon', couponSchema);
