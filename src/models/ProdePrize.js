
const mongoose = require('mongoose');

// ── Una "semana" de premio (usado por el 1er puesto: 4 cupones escalonados) ──
const prizeWeekSchema = new mongoose.Schema({
  label:       { type: String, required: true },        // 'W1', 'W2', 'W3', 'W4'
  sendAt:      { type: Date, required: true },           // cuándo corresponde enviar este cupón
  sent:        { type: Boolean, default: false },
  sentAt:      { type: Date, default: null },
  couponCode:  { type: String, default: null },
  coupon:      { type: mongoose.Schema.Types.ObjectId, ref: 'Coupon', default: null },
  error:       { type: String, default: null },          // último error al intentar enviar (si lo hubo)
}, { _id: false });

// ── Premio entregado a un puesto del Prode (1ro, 2do, 3ro) ────────────────────
const prodePrizeSchema = new mongoose.Schema({
  position:    { type: Number, required: true, enum: [1, 2, 3] },
  client:      { type: mongoose.Schema.Types.ObjectId, ref: 'Client', required: true },
  clientName:  { type: String, default: '' },
  prizeLabel:  { type: String, default: '' },   // descripción humana, ej: "4 semanas de Janz gratis"
  // 'season' permite repetir el sistema en futuros torneos sin chocar con premios anteriores.
  season:      { type: String, required: true },
  // Semanas escalonadas (solo el 1er puesto las usa; 2do/3ro tienen 1 sola entrada con label 'UNICO')
  weeks:       [prizeWeekSchema],
  totalPointsAtAward: { type: Number, default: 0 }, // puntos del cliente al momento de premiar (auditoría)
}, { timestamps: true });

// Evita premiar 2 veces la misma posición en la misma temporada (idempotencia)
prodePrizeSchema.index({ position: 1, season: 1 }, { unique: true });

module.exports = mongoose.model('ProdePrize', prodePrizeSchema);
