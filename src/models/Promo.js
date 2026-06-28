const mongoose = require('mongoose');

const promoComponentSchema = new mongoose.Schema({
  product:  { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  quantity: { type: Number, default: 1, min: 1 },
}, { _id: false });

const promoSchema = new mongoose.Schema({
  name:        { type: String, required: true, trim: true },
  description: { type: String, trim: true, default: '' },
  components:  { type: [promoComponentSchema], required: true },
  salePrice:   { type: Number, required: true },   // precio de venta de la promo
  image:       { type: String, default: null },
  active:      { type: Boolean, default: true },
  available:   { type: Boolean, default: true },   // se apaga si algún componente no tiene stock
}, { timestamps: true });

module.exports = mongoose.model('Promo', promoSchema);
