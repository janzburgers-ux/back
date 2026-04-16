const mongoose = require('mongoose');

const reviewSchema = new mongoose.Schema({
  // Referencia al pedido
  order:       { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true, unique: true },
  orderNumber: { type: String },
  publicCode:  { type: String },

  // Referencia al cliente
  client:      { type: mongoose.Schema.Types.ObjectId, ref: 'Client' },
  clientName:  { type: String },
  clientWhatsapp: { type: String },

  // Calificación principal (1-5 estrellas)
  stars: { type: Number, min: 1, max: 5, required: true },

  // Preguntas rápidas
  burgerRating: { type: String, enum: ['perfecta', 'muy_buena', 'bien', 'mejorable', ''], default: '' },
  tempRating:   { type: String, enum: ['caliente', 'tibia', 'fria', ''], default: '' },
  onTime:       { type: Boolean, default: null },

  // Comentario libre y foto
  comment: { type: String, default: '' },
  photo:   { type: String, default: '' }, // URL de Cloudinary (opcional)

  // Incentivo generado
  incentiveType:   { type: String, enum: ['discount', 'product', 'none'], default: 'none' },
  couponGenerated: { type: String, default: null }, // código del cupón
  couponId:        { type: mongoose.Schema.Types.ObjectId, ref: 'Coupon', default: null },
  incentiveSent:   { type: Boolean, default: false },

  // Estado
  completed:   { type: Boolean, default: false }, // el cliente completó el formulario
  reviewed:    { type: Boolean, default: false }, // admin la marcó como leída
  requestSent: { type: Boolean, default: false }, // si ya se envió el WhatsApp de pedido de reseña
}, { timestamps: true });

// Índices para queries admin
reviewSchema.index({ createdAt: -1 });
reviewSchema.index({ stars: 1 });
reviewSchema.index({ client: 1 });
reviewSchema.index({ completed: 1 });

module.exports = mongoose.model('Review', reviewSchema);
