const mongoose = require('mongoose');

const additionalSchema = new mongoose.Schema({
  name:        { type: String, required: true, trim: true },
  description: { type: String, trim: true },
  price:       { type: Number, required: true, default: 0 },
  emoji:       { type: String, default: '➕' },
  category:    { type: String, enum: ['hamburguesa', 'papas', 'salsa'], default: 'hamburguesa' },
  active:      { type: Boolean, default: true }
}, { timestamps: true });

module.exports = mongoose.model('Additional', additionalSchema);