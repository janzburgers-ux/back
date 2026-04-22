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
  // visible: controla si aparece en el menú público /pedido.
  // active=false → eliminado del sistema. visible=false → oculto solo del menú público.
  visible: { type: Boolean, default: true },
  image: { type: String },
  description: { type: String },
  // Tipo de producto: controla qué adicionales se muestran al cliente al personalizar
  // 'burger' → adicionales de hamburguesa + papas + salsas
  // 'papas'  → solo adicionales de papas + salsas
  // 'otro'   → todos los adicionales
  productType: { type: String, enum: ['burger', 'papas', 'otro'], default: 'burger' },

  // ── Destacados ─────────────────────────────────────────────────────────────
  // isDailyBurger: se muestra como "Hamburguesa del día" con precio especial y countdown
  isDailyBurger:       { type: Boolean, default: false },
  dailyDiscountPrice:  { type: Number, default: 0 },   // precio con descuento (0 = sin descuento)
  dailyFromHour:       { type: String, default: '' },   // ej: "19:00"
  dailyToHour:         { type: String, default: '' },   // ej: "21:00"

  // isMonthlyBurger: se muestra como "Hamburguesa del mes" (solo puede haber 1 activa)
  isMonthlyBurger:     { type: Boolean, default: false },
  monthlyLabel:        { type: String, default: '' }    // ej: "Abril 2025"
}, { timestamps: true });

const Recipe = mongoose.model('Recipe', recipeSchema);
const Product = mongoose.model('Product', productSchema);

module.exports = { Recipe, Product };