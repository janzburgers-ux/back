const mongoose = require('mongoose');

const additionalSchema = new mongoose.Schema({
  name:        { type: String, required: true, trim: true },
  description: { type: String, trim: true },
  price:       { type: Number, required: true, default: 0 },
  emoji:       { type: String, default: '➕' },
  category:    { type: String, enum: ['hamburguesa', 'papas', 'salsa'], default: 'hamburguesa' },
  // appliesTo: en qué tipo de producto aparece como opción al cliente
  // 'burger'  → solo en productos de tipo burger
  // 'papas'   → solo en productos de tipo papas
  // 'todos'   → en cualquier tipo de producto
  appliesTo:   { type: String, enum: ['burger', 'papas', 'todos'], default: 'burger' },
  active:      { type: Boolean, default: true },

  // ── Fase 3: vínculo opcional con ingrediente de stock ────────────────────
  // Si está seteado, el sistema descuenta stock cuando se pide este adicional.
  // Si queda null, el adicional no trackea stock (ej. salsas de bidón grande).
  ingredient:       { type: mongoose.Schema.Types.ObjectId, ref: 'Ingredient', default: null },
  consumesQuantity: { type: Number, default: 1 },   // cantidad de ingrediente que consume por unidad
  consumesUnit:     { type: String, default: '' },   // unidad (informativo, para mostrar en admin)
  available:        { type: Boolean, default: true } // se apaga automáticamente cuando ingredient queda sin stock
}, { timestamps: true });

module.exports = mongoose.model('Additional', additionalSchema);
