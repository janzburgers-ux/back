const mongoose = require('mongoose');

// Calcula el ID del finde (YYYY-MM-DD del viernes correspondiente)
// Vie/Sáb/Dom → ese finde | Lun-Jue → el finde anterior
function getWeekId(date) {
  const d = new Date(date);
  const day = d.getDay(); // 0=Dom, 5=Vie, 6=Sáb
  const offset = -((day - 5 + 7) % 7);
  const friday = new Date(d);
  friday.setDate(d.getDate() + offset);
  return friday.toISOString().split('T')[0];
}

const cashMovementSchema = new mongoose.Schema({
  // Agrupación por finde (YYYY-MM-DD del viernes)
  weekId: { type: String, required: true, index: true },

  date: { type: Date, required: true },

  // Tipo de movimiento
  type: {
    type: String,
    enum: ['purchase', 'withdrawal', 'other'],
    required: true
  },

  description: { type: String, required: true, trim: true },
  amount:      { type: Number, required: true, min: 0 },

  paymentMethod: {
    type: String,
    enum: ['efectivo', 'digital'],
    default: 'efectivo'
  },

  // Solo para retiros: a qué integrante corresponde
  memberId: { type: String, default: null },

  notes: { type: String, default: '' }
}, { timestamps: true });

// Helper estático para reutilizar en las rutas
cashMovementSchema.statics.getWeekId = getWeekId;

module.exports = mongoose.model('CashMovement', cashMovementSchema);
