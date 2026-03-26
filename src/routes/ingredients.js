const express = require('express');
const router = express.Router();
const Ingredient = require('../models/Ingredient');
const { auth, adminOnly } = require('../middleware/auth');
const { recalculateProductCosts } = require('../services/stock.service');

// Get all ingredients
router.get('/', auth, async (req, res) => {
  try {
    const ingredients = await Ingredient.find({ active: true }).sort('category name');
    res.json(ingredients);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Create ingredient
router.post('/', auth, adminOnly, async (req, res) => {
  try {
    const ingredient = new Ingredient(req.body);
    await ingredient.save();
    res.status(201).json(ingredient);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// Update ingredient (triggers price recalculation if cost changes)
router.put('/:id', auth, adminOnly, async (req, res) => {
  try {
    const costChanged = req.body.packageCost !== undefined;
    
    const ingredient = await Ingredient.findById(req.params.id);
    if (!ingredient) return res.status(404).json({ message: 'Ingrediente no encontrado' });

    Object.assign(ingredient, req.body);
    // Recalculate costPerUnit
    if (ingredient.quantityPerPackage > 0) {
      ingredient.costPerUnit = ingredient.packageCost / ingredient.quantityPerPackage;
    }
    await ingredient.save();

    let affectedProducts = [];
    if (costChanged) {
      // Cascade recalculation across all products using this ingredient
      affectedProducts = await recalculateProductCosts(ingredient._id);
    }

    res.json({ ingredient, affectedProducts, pricesRecalculated: costChanged });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// Delete (soft delete)
router.delete('/:id', auth, adminOnly, async (req, res) => {
  try {
    const { Recipe } = require('../models/Product');
    const Stock = require('../models/Stock');

    // Verificar si está en alguna receta activa
    const inRecipe = await Recipe.findOne({ 'ingredients.ingredient': req.params.id });
    if (inRecipe) {
      return res.status(400).json({
        message: 'Este ingrediente está siendo usado en una o más recetas. Eliminalo de las recetas primero.',
        inUse: true
      });
    }

    // Eliminar stock asociado
    await Stock.deleteOne({ ingredient: req.params.id });

    // Eliminar el ingrediente
    await Ingredient.findByIdAndDelete(req.params.id);
    res.json({ message: 'Ingrediente eliminado correctamente' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
