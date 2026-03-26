const mongoose = require('mongoose');

// Recipe ingredient sub-schema
const recipeIngredientSchema = new mongoose.Schema({
  ingredient: { type: mongoose.Schema.Types.ObjectId, ref: 'Ingredient', required: true },
  quantity: { type: Number, required: true },
  unit: { type: String, required: true }
}, { _id: false });

// Recipe schema
const recipeSchema = new mongoose.Schema({
  name: { type: String, required: true },
  ingredients: [recipeIngredientSchema],
  totalCost: { type: Number, default: 0 }
}, { timestamps: true });

// Product schema (burger variants)
const productSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  variant: { type: String, required: true },
  salePrice: { type: Number, required: true },
  recipe: { type: mongoose.Schema.Types.ObjectId, ref: 'Recipe' },
  totalCost: { type: Number, default: 0 },
  ingredientCost: { type: Number, default: 0 },
  indirectCost: { type: Number, default: 0 },
  fixedCostPerUnit: { type: Number, default: 0 },   // gastos fijos distribuidos por burger
  deliveryCostPerUnit: { type: Number, default: 0 }, // costo de delivery distribuido por burger
  packagingCostPerUnit: { type: Number, default: 0 }, // packaging por unidad
  realTotalCost: { type: Number, default: 0 },        // costo real completo
  profit: { type: Number, default: 0 },
  margin: { type: Number, default: 0 },
  desiredMargin: { type: Number, default: 300 },
  suggestedPrice: { type: Number, default: 0 },
  active: { type: Boolean, default: true },
  available: { type: Boolean, default: true },
  image: { type: String },
  description: { type: String }
}, { timestamps: true });

const Recipe = mongoose.model('Recipe', recipeSchema);
const Product = mongoose.model('Product', productSchema);

module.exports = { Recipe, Product };
