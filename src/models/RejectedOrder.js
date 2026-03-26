const mongoose = require('mongoose');

const rejectedOrderSchema = new mongoose.Schema({
  orderNumber: { type: String },
  publicCode:  { type: String },
  client: {
    name:     { type: String },
    whatsapp: { type: String },
    phone:    { type: String }
  },
  items: [{
    productName: { type: String },
    variant:     { type: String },
    quantity:    { type: Number }
  }],
  total:       { type: Number, default: 0 },
  reason:      { type: String, enum: ['sin_stock', 'cocina_cerrada', 'otro'], default: 'sin_stock' },
  notes:       { type: String, default: '' },
  missingStock: [{ ingredient: { type: String }, needed: { type: Number }, available: { type: Number } }],
  rejectedAt:  { type: Date, default: Date.now }
}, { timestamps: true });

module.exports = mongoose.model('RejectedOrder', rejectedOrderSchema);
