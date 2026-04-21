const mongoose = require('mongoose');

const pinSchema = new mongoose.Schema({
  wa:        { type: String, required: true },
  pin:       { type: String, required: true },
  expiresAt: { type: Date, required: true },
  used:      { type: Boolean, default: false }
}, { timestamps: true });

// TTL index — MongoDB borra el documento automáticamente cuando expira
pinSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('PinVerification', pinSchema);