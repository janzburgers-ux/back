const mongoose = require('mongoose');

const ingredientSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  unit: { type: String, required: true },
  packageUnit: { type: String },
  quantityPerPackage: { type: Number, default: 1 },
  packageCost: { type: Number, required: true, default: 0 },
  costPerUnit: { type: Number }, // auto-calculated
  category: {
    type: String,
    enum: ['Proteína', 'Lácteos', 'Verduras', 'Almacén', 'Salsas', 'Descartables'],
    default: 'Almacén'
  },
  perishable: { type: Boolean, default: false }, // for ABC priority
  priority: { type: String, enum: ['A', 'B', 'C'], default: 'B' }, // ABC classification
  active: { type: Boolean, default: true }
}, { timestamps: true });

// Auto-calculate cost per unit before save
ingredientSchema.pre('save', function(next) {
  if (this.quantityPerPackage > 0) {
    this.costPerUnit = this.packageCost / this.quantityPerPackage;
  }
  next();
});

ingredientSchema.pre('findOneAndUpdate', function(next) {
  const update = this.getUpdate();
  if (update.packageCost !== undefined && update.quantityPerPackage !== undefined) {
    update.costPerUnit = update.packageCost / update.quantityPerPackage;
  } else if (update.$set) {
    if (update.$set.packageCost !== undefined || update.$set.quantityPerPackage !== undefined) {
      // Will need to fetch and recalculate - handled in route
    }
  }
  next();
});

module.exports = mongoose.model('Ingredient', ingredientSchema);
