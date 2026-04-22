const express = require('express');
const router = express.Router();
const { Product, Recipe } = require('../models/Product');
const Ingredient = require('../models/Ingredient');
const Config = require('../models/Config');
const { auth, adminOnly } = require('../middleware/auth');

async function getIndirectPct() {
  const cfg = await Config.findOne({ key: 'indirectCosts' });
  const costs = cfg?.value || { luz: 5, gas: 3, packaging: 4, otros: 3 };
  return Object.values(costs).reduce((s, v) => s + Number(v), 0);
}

async function getDesiredMargin() {
  const cfg = await Config.findOne({ key: 'desiredMargin' });
  return cfg?.value || 300;
}

// GET all products
router.get('/', auth, async (req, res) => {
  try {
    const products = await Product.find({ active: true })
      .populate({ path: 'recipe', populate: { path: 'ingredients.ingredient' } })
      .sort('name variant');
    res.json(products);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET all recipes
router.get('/recipes', auth, async (req, res) => {
  try {
    const recipes = await Recipe.find().populate('ingredients.ingredient');
    res.json(recipes);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PUT update recipe
router.put('/recipes/:id', auth, adminOnly, async (req, res) => {
  try {
    let totalCost = 0;
    for (const ri of req.body.ingredients) {
      const ing = await Ingredient.findById(ri.ingredient);
      if (ing) totalCost += (ing.costPerUnit || 0) * ri.quantity;
    }
    const recipe = await Recipe.findByIdAndUpdate(
      req.params.id,
      { ingredients: req.body.ingredients, totalCost: Math.round(totalCost) },
      { new: true }
    );
    if (!recipe) return res.status(404).json({ message: 'Receta no encontrada' });
    res.json(recipe);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// POST create recipe
router.post('/recipes', auth, adminOnly, async (req, res) => {
  try {
    let totalCost = 0;
    for (const ri of req.body.ingredients) {
      const ing = await Ingredient.findById(ri.ingredient);
      if (ing) totalCost += (ing.costPerUnit || 0) * ri.quantity;
    }
    const recipe = new Recipe({ ...req.body, totalCost: Math.round(totalCost) });
    await recipe.save();
    res.status(201).json(recipe);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// POST create product
router.post('/', auth, adminOnly, async (req, res) => {
  try {
    const indirectPct = await getIndirectPct();
    const desiredMargin = await getDesiredMargin();
    let ingredientCost = 0;

    if (req.body.recipe) {
      const recipe = await Recipe.findById(req.body.recipe).populate('ingredients.ingredient');
      if (recipe) {
        for (const ri of recipe.ingredients) {
          ingredientCost += (ri.ingredient?.costPerUnit || 0) * ri.quantity;
        }
      }
    }

    const indirectCost = Math.round(ingredientCost * indirectPct / 100);
    const totalCost = Math.round(ingredientCost + indirectCost);
    const salePrice = req.body.salePrice;
    const profit = salePrice - totalCost;
    const margin = salePrice > 0 ? Math.round((profit / salePrice) * 100) : 0;
    const suggestedPrice = Math.round(totalCost * (1 + desiredMargin / 100));

    const product = new Product({
      ...req.body,
      ingredientCost: Math.round(ingredientCost),
      indirectCost,
      totalCost,
      profit,
      margin,
      suggestedPrice
    });
    await product.save();
    res.status(201).json(product);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// PUT update product
// GET producto por ID (con receta poblada)
router.get('/:id', auth, async (req, res) => {
  try {
    const product = await Product.findById(req.params.id)
      .populate({ path: 'recipe', populate: { path: 'ingredients.ingredient' } });
    if (!product) return res.status(404).json({ message: 'Producto no encontrado' });
    res.json(product);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.put('/:id', auth, adminOnly, async (req, res) => {
  try {
    const product = await Product.findById(req.params.id).populate({
      path: 'recipe', populate: { path: 'ingredients.ingredient' }
    });
    if (!product) return res.status(404).json({ message: 'Producto no encontrado' });

    const indirectPct = await getIndirectPct();
    const desiredMargin = await getDesiredMargin();

    // Recalcular si cambia el precio
    const newSalePrice = req.body.salePrice !== undefined ? Number(req.body.salePrice) : product.salePrice;
    const ingredientCost = product.ingredientCost || 0;
    const indirectCost = Math.round(ingredientCost * indirectPct / 100);
    const totalCost = Math.round(ingredientCost + indirectCost);
    const profit = newSalePrice - totalCost;
    const margin = newSalePrice > 0 ? Math.round((profit / newSalePrice) * 100) : 0;
    const suggestedPrice = Math.round(totalCost * (1 + desiredMargin / 100));

    const updated = await Product.findByIdAndUpdate(req.params.id, {
      ...req.body,
      indirectCost,
      totalCost,
      profit,
      margin,
      suggestedPrice
    }, { new: true });

    res.json(updated);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// PATCH marcar como hamburguesa del día
router.patch('/:id/daily', auth, adminOnly, async (req, res) => {
  try {
    const { isDailyBurger, dailyDiscountPrice, dailyFromHour, dailyToHour } = req.body;

    // Si se activa, desactivar cualquier otra que estuviera como del día
    if (isDailyBurger) {
      await Product.updateMany({ isDailyBurger: true }, { $set: { isDailyBurger: false } });
    }

    const updated = await Product.findByIdAndUpdate(
      req.params.id,
      { isDailyBurger: !!isDailyBurger, dailyDiscountPrice: dailyDiscountPrice || 0, dailyFromHour: dailyFromHour || '', dailyToHour: dailyToHour || '' },
      { new: true }
    );
    if (!updated) return res.status(404).json({ message: 'Producto no encontrado' });
    res.json(updated);
  } catch (err) { res.status(400).json({ message: err.message }); }
});

// PATCH marcar como hamburguesa del mes
router.patch('/:id/monthly', auth, adminOnly, async (req, res) => {
  try {
    const { isMonthlyBurger, monthlyLabel } = req.body;

    // Si se activa, desactivar cualquier otra que estuviera como del mes
    if (isMonthlyBurger) {
      await Product.updateMany({ isMonthlyBurger: true }, { $set: { isMonthlyBurger: false } });
    }

    const updated = await Product.findByIdAndUpdate(
      req.params.id,
      { isMonthlyBurger: !!isMonthlyBurger, monthlyLabel: monthlyLabel || '' },
      { new: true }
    );
    if (!updated) return res.status(404).json({ message: 'Producto no encontrado' });
    res.json(updated);
  } catch (err) { res.status(400).json({ message: err.message }); }
});

// DELETE product (soft-delete: active: false)
// También llama a autoUpdateProductAvailability para que el stock
// no quede desalineado con productos que ya no existen en el menú.
router.delete('/:id', auth, adminOnly, async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ message: 'Producto no encontrado' });

    await Product.findByIdAndUpdate(req.params.id, { active: false, available: false });

    // Actualizar disponibilidad de los demás productos sin afectar el stock
    const { autoUpdateProductAvailability } = require('../services/stock.service');
    autoUpdateProductAvailability().catch(e => console.error('Auto-availability error:', e.message));

    res.json({ message: 'Producto eliminado' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;