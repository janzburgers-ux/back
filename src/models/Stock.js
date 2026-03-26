const mongoose = require('mongoose');

const stockSchema = new mongoose.Schema({
  ingredient: { type: mongoose.Schema.Types.ObjectId, ref: 'Ingredient', required: true },
  currentStock: { type: Number, required: true, default: 0 },
  minimumStock: { type: Number, required: true, default: 0 },
  unit: { type: String, required: true },
  lastUpdated: { type: Date, default: Date.now },
  notes: { type: String },
  alertSeen: { type: Boolean, default: false }, // admin marcó la alerta como vista
  status: {
    type: String,
    enum: ['ok', 'low', 'out'],
    default: 'ok'
  }
}, { timestamps: true });

// Auto calculate status
stockSchema.pre('save', function(next) {
  const prevStatus = this._prevStatus;
  if (this.currentStock <= 0) {
    this.status = 'out';
  } else if (this.currentStock < this.minimumStock) {
    this.status = 'low';
  } else {
    this.status = 'ok';
    this.alertSeen = false; // resetear cuando vuelve a OK
  }
  // Si cambió a crítico, resetear alertSeen para que aparezca de nuevo
  if ((this.status === 'out' || this.status === 'low') && prevStatus === 'ok') {
    this.alertSeen = false;
  }
  this.lastUpdated = new Date();
  next();
});

module.exports = mongoose.model('Stock', stockSchema);
