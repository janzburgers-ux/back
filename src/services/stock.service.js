const Stock = require('../models/Stock');
const { Recipe, Product } = require('../models/Product');
const Ingredient = require('../models/Ingredient');

// ── Reservar stock atómicamente (Fase 1: race condition) ─────────────────────
// Intenta descontar todos los ingredientes necesarios con findOneAndUpdate atómico.
// Si alguno falla por stock insuficiente, revierte todo lo que ya se descontó.
// Devuelve { ok: true } o { ok: false, unavailableItems, adjustedItems, adjustedTotal }
async function reserveStockForOrder(orderItems) {
  const Additional = require('../models/Additional');

  // 1. Calcular ingredientes necesarios por item de pedido
  const itemIngredients = [];

  for (let idx = 0; idx < orderItems.length; idx++) {
    const item = orderItems[idx];
    // ── Ingredientes del producto base ──
    const product = await Product.findById(item.product).populate('recipe');
    if (product?.recipe) {
      const recipe = await Recipe.findById(product.recipe).populate('ingredients.ingredient');
      if (recipe) {
        for (const ri of recipe.ingredients) {
          const ingId = ri.ingredient._id.toString();
          itemIngredients.push({
            itemIdx: idx,
            ingId,
            ingName: ri.ingredient.name,
            needed: ri.quantity * item.quantity,
            productId: item.product.toString(),
            productName: item.productName || product.name,
            variant: item.variant || product.variant,
            unitPrice: item.unitPrice || product.salePrice,
            quantity: item.quantity,
            additionals: item.additionals || []
          });
        }
      }
    }
    // ── Ingredientes de adicionales vinculados ──
    for (const a of (item.additionals || [])) {
      const add = await Additional.findById(a.additional || a._id);
      if (!add?.ingredient) continue;
      const ingId = add.ingredient.toString();
      itemIngredients.push({
        itemIdx: idx,
        ingId,
        ingName: add.name,
        needed: add.consumesQuantity * (a.quantity || 1),
        productId: item.product.toString(),
        productName: item.productName,
        variant: item.variant,
        unitPrice: item.unitPrice,
        quantity: item.quantity,
        additionals: item.additionals || []
      });
    }
  }

  // 2. Consolidar por ingrediente
  const ingMap = {};
  for (const ii of itemIngredients) {
    if (!ingMap[ii.ingId]) ingMap[ii.ingId] = { ingName: ii.ingName, needed: 0, itemIdxs: new Set() };
    ingMap[ii.ingId].needed += ii.needed;
    ingMap[ii.ingId].itemIdxs.add(ii.itemIdx);
  }

  // 3. Intentar reserva atómica por ingrediente
  const reserved = [];
  const failedIngredients = new Set();
  const failedItemIdxs = new Set();

  for (const [ingId, { ingName, needed, itemIdxs }] of Object.entries(ingMap)) {
    const result = await Stock.findOneAndUpdate(
      { ingredient: ingId, currentStock: { $gte: needed } },
      { $inc: { currentStock: -needed } },
      { new: true }
    );
    if (result) {
      reserved.push({ ingId, needed });
    } else {
      failedIngredients.add(ingId);
      itemIdxs.forEach(i => failedItemIdxs.add(i));
    }
  }

  // 4. Si todo ok, retornar éxito
  if (failedIngredients.size === 0) {
    return { ok: true };
  }

  // 5. Rollback de lo que ya se reservó
  for (const { ingId, needed } of reserved) {
    await Stock.findOneAndUpdate(
      { ingredient: ingId },
      { $inc: { currentStock: needed } }
    );
  }

  // 6. Construir respuesta con items ajustados
  const unavailableItems = orderItems
    .filter((_, idx) => failedItemIdxs.has(idx))
    .map(item => ({ productId: item.product.toString(), productName: item.productName, variant: item.variant }));

  const adjustedItems = orderItems.filter((_, idx) => !failedItemIdxs.has(idx));
  const adjustedTotal = adjustedItems.reduce((sum, item) => {
    const addsCost = (item.additionals || []).reduce((s, a) => s + a.unitPrice * (a.quantity || 1), 0);
    return sum + item.unitPrice * item.quantity + addsCost;
  }, 0);

  return { ok: false, unavailableItems, adjustedItems, adjustedTotal };
}

// ── Descontar stock al confirmar pedido ──────────────────────────────────────
async function deductStockForOrder(orderItems) {
  const Additional = require('../models/Additional');
  const deductions = {};

  for (const item of orderItems) {
    // Ingredientes del producto base
    const product = await Product.findById(item.product).populate('recipe');
    if (product?.recipe) {
      const recipe = await Recipe.findById(product.recipe).populate('ingredients.ingredient');
      if (recipe) {
        for (const ri of recipe.ingredients) {
          const ingId = ri.ingredient._id.toString();
          deductions[ingId] = (deductions[ingId] || 0) + ri.quantity * item.quantity;
        }
      }
    }
    // Ingredientes de adicionales vinculados
    for (const a of (item.additionals || [])) {
      const add = await Additional.findById(a.additional || a._id);
      if (!add?.ingredient) continue;
      const ingId = add.ingredient.toString();
      deductions[ingId] = (deductions[ingId] || 0) + add.consumesQuantity * (a.quantity || 1);
    }
  }

  const results = [];
  for (const [ingredientId, quantity] of Object.entries(deductions)) {
    const stock = await Stock.findOne({ ingredient: ingredientId });
    if (!stock) { results.push({ ingredientId, status: 'not_found', quantity }); continue; }
    const previousStock = stock.currentStock;
    stock.currentStock = Math.max(0, stock.currentStock - quantity);
    await stock.save();
    results.push({ ingredientId, ingredient: stock.ingredient, previousStock, newStock: stock.currentStock, deducted: quantity, status: stock.status });
  }
  return results;
}

// ── Calcular costo de packaging por pedido ────────────────────────────────────
// Reglas: 1 bolsa c/3 burgers, 1 papel aluminio x burger, 1 bandejita x burger. Bebidas: sin packaging.
function calcPackagingForOrder(items) {
  const totalBurgers = items.reduce((s, i) => s + i.quantity, 0);
  const bags = Math.ceil(totalBurgers / 3);
  const aluminumFoil = totalBurgers;
  const trays = totalBurgers;
  return { bags, aluminumFoil, trays, totalBurgers };
}

async function calcPackagingCost(items) {
  const { bags, aluminumFoil, trays } = calcPackagingForOrder(items);

  const [bolsasIng, papelIng, bandejitasIng] = await Promise.all([
    Ingredient.findOne({ name: { $regex: /bolsa/i } }),
    Ingredient.findOne({ name: { $regex: /papel aluminio/i } }),
    Ingredient.findOne({ name: { $regex: /bandejita/i } })
  ]);

  const cost =
    (bolsasIng?.costPerUnit || 0) * bags +
    (papelIng?.costPerUnit || 0) * aluminumFoil +
    (bandejitasIng?.costPerUnit || 0) * trays;

  return { cost: Math.round(cost), detail: { bags, aluminumFoil, trays } };
}

// ── Recalcular costos de productos cuando cambia un ingrediente ──────────────
async function recalculateProductCosts(ingredientId) {
  const ingredient = await Ingredient.findById(ingredientId);
  if (!ingredient) return [];
  const recipes = await Recipe.find({ 'ingredients.ingredient': ingredientId }).populate('ingredients.ingredient');
  const updatedProducts = [];
  for (const recipe of recipes) {
    let recipeCost = 0;
    for (const ri of recipe.ingredients) {
      const ing = await Ingredient.findById(ri.ingredient);
      if (ing) recipeCost += ing.costPerUnit * ri.quantity;
    }
    recipe.totalCost = Math.round(recipeCost);
    await recipe.save();
    const products = await Product.find({ recipe: recipe._id });
    for (const product of products) {
      const previousCost = product.totalCost;
      product.totalCost = recipe.totalCost;
      product.profit = product.salePrice - product.totalCost;
      product.margin = product.salePrice > 0 ? Math.round((product.profit / product.salePrice) * 100) : 0;
      await product.save();
      updatedProducts.push({ productId: product._id, name: `${product.name} ${product.variant}`, previousCost, newCost: product.totalCost, margin: product.margin });
    }
  }
  return updatedProducts;
}

// ── Lista de compras normal (deficit vs mínimo) ───────────────────────────────
async function generateShoppingList() {
  const stocks = await Stock.find().populate('ingredient');
  const shoppingList = [];
  for (const stock of stocks) {
    if (!stock.ingredient) continue;
    if (stock.currentStock < stock.minimumStock) {
      const deficit = stock.minimumStock - stock.currentStock;
      const ingredient = stock.ingredient;
      shoppingList.push({
        ingredient: ingredient._id,
        name: ingredient.name,
        unit: stock.unit,
        currentStock: stock.currentStock,
        minimumStock: stock.minimumStock,
        deficit,
        estimatedCost: Math.round((ingredient.costPerUnit || 0) * deficit),
        priority: ingredient.priority || 'B',
        perishable: ingredient.perishable || false,
        category: ingredient.category,
        status: stock.status
      });
    }
  }
  shoppingList.sort((a, b) => {
    const p = { A: 0, B: 1, C: 2 };
    if (p[a.priority] !== p[b.priority]) return p[a.priority] - p[b.priority];
    if (a.perishable !== b.perishable) return b.perishable ? 1 : -1;
    return { out: 0, low: 1, ok: 2 }[a.status] - { out: 0, low: 1, ok: 2 }[b.status];
  });
  return { items: shoppingList, totalEstimated: shoppingList.reduce((s, i) => s + i.estimatedCost, 0) };
}

// ── Lista de compras por objetivo de producción ──────────────────────────────
// Calcula cuánto de cada ingrediente se necesita para producir `targetBurgers` unidades
// usando un mix proporcional de todos los productos activos
async function generateProductionShoppingList(targetBurgers = 50) {
  const allProducts = await Product.find({ active: true })
    .populate({ path: 'recipe', populate: { path: 'ingredients.ingredient' } });

  // Tomar solo 1 variante por nombre de producto para no duplicar ingredientes.
  // Se elige la primera que tenga receta asignada; si ninguna la tiene, la primera.
  const seen = new Set();
  const products = [];
  for (const p of allProducts) {
    if (seen.has(p.name)) continue;
    if (p.recipe?.ingredients?.length) {
      seen.add(p.name);
      products.push(p);
    }
  }
  // Segunda pasada: agregar productos sin receta que no hayamos visto (para no perderlos)
  for (const p of allProducts) {
    if (!seen.has(p.name)) {
      seen.add(p.name);
      products.push(p);
    }
  }

  if (!products.length) return { items: [], totalEstimated: 0, targetBurgers };

  // Distribuir el objetivo uniformemente entre los productos únicos
  const burgersPerProduct = Math.ceil(targetBurgers / products.length);

  // Acumular necesidades totales de ingredientes
  const needed = {}; // ingredientId -> { name, unit, quantity, costPerUnit, category, priority, perishable }
  for (const product of products) {
    if (!product.recipe?.ingredients?.length) continue;
    for (const ri of product.recipe.ingredients) {
      const ing = ri.ingredient;
      if (!ing) continue;
      const id = ing._id.toString();
      if (!needed[id]) {
        needed[id] = {
          ingredientId: id,
          name: ing.name,
          unit: ri.unit,
          category: ing.category,
          priority: ing.priority || 'B',
          perishable: ing.perishable || false,
          costPerUnit: ing.costPerUnit || 0,
          needed: 0
        };
      }
      needed[id].needed += ri.quantity * burgersPerProduct;
    }
  }

  // Agregar packaging estimado (basado en targetBurgers)
  const packagingIngredients = [
    { pattern: /bolsa/i, quantity: Math.ceil(targetBurgers / 3), label: 'Bolsas (packaging)' },
    { pattern: /papel aluminio/i, quantity: targetBurgers, label: 'Papel aluminio (packaging)' },
    { pattern: /bandejita/i, quantity: targetBurgers, label: 'Bandejitas (packaging)' }
  ];
  for (const pkg of packagingIngredients) {
    const ing = await Ingredient.findOne({ name: { $regex: pkg.pattern } });
    if (ing) {
      const id = ing._id.toString();
      if (needed[id]) needed[id].needed += pkg.quantity;
      else needed[id] = { ingredientId: id, name: ing.name, unit: 'unidad', category: 'Descartables', priority: 'C', perishable: false, costPerUnit: ing.costPerUnit || 0, needed: pkg.quantity };
    }
  }

  // Comparar contra stock actual
  const stocks = await Stock.find().populate('ingredient');
  const stockMap = {};
  stocks.forEach(s => { if (s.ingredient) stockMap[s.ingredient._id.toString()] = s.currentStock; });

  const result = [];
  for (const item of Object.values(needed)) {
    const currentStock = stockMap[item.ingredientId] || 0;
    const deficit = Math.max(0, item.needed - currentStock);
    const canProduce = item.needed > 0 ? Math.floor((currentStock / item.needed) * targetBurgers) : targetBurgers;

    result.push({
      ...item,
      needed: Math.round(item.needed * 100) / 100,
      currentStock,
      deficit: Math.round(deficit * 100) / 100,
      estimatedCost: Math.round(item.costPerUnit * deficit),
      canProduce: Math.min(canProduce, targetBurgers),
      isCritical: deficit > 0
    });
  }

  // Ordenar: críticos primero, luego por prioridad
  result.sort((a, b) => {
    if (a.isCritical !== b.isCritical) return b.isCritical ? 1 : -1;
    const p = { A: 0, B: 1, C: 2 };
    return (p[a.priority] || 1) - (p[b.priority] || 1);
  });

  const minCanProduce = result.length > 0
    ? Math.min(...result.filter(r => r.needed > 0).map(r => r.canProduce))
    : targetBurgers;

  return {
    items: result,
    totalEstimated: result.reduce((s, i) => s + i.estimatedCost, 0),
    targetBurgers,
    canProduceNow: minCanProduce,
    isReady: minCanProduce >= targetBurgers,
    criticalItems: result.filter(r => r.isCritical).length
  };
}



// ── Auto-deshabilitar productos cuando no hay stock para hacerlos ────────────
async function autoUpdateProductAvailability() {
  try {
    const products = await Product.find({ active: true }).populate('recipe');
    const stockMap = {};
    const allStock = await Stock.find().populate('ingredient');
    allStock.forEach(s => { stockMap[s.ingredient?._id?.toString()] = s; });

    for (const product of products) {
      if (!product.recipe) continue;
      const recipe = await Recipe.findById(product.recipe).populate('ingredients.ingredient');
      if (!recipe) continue;

      // Verificar si hay stock suficiente para al menos 1 unidad
      let canMake = true;
      for (const ri of recipe.ingredients) {
        const ingId = ri.ingredient?._id?.toString();
        const stock = stockMap[ingId];
        if (!stock || stock.currentStock < ri.quantity) {
          canMake = false;
          break;
        }
      }

      // Solo actualizar si cambió el estado
      if (product.available !== canMake) {
        await Product.findByIdAndUpdate(product._id, { available: canMake });
        console.log(`📦 [Stock] ${product.name} ${product.variant} → ${canMake ? 'disponible' : 'sin stock'}`);
      }
    }
  } catch (err) {
    console.error('Error en autoUpdateProductAvailability:', err.message);
  }
}

// ── Auto-deshabilitar adicionales cuando no hay stock para su ingrediente ─────
async function autoUpdateAdditionalAvailability() {
  try {
    const Additional = require('../models/Additional');
    const additionals = await Additional.find({ active: true, ingredient: { $ne: null } });
    const stockMap = {};
    const allStock = await Stock.find().populate('ingredient');
    allStock.forEach(s => { stockMap[s.ingredient?._id?.toString()] = s; });

    for (const add of additionals) {
      const ingId = add.ingredient?.toString();
      if (!ingId) continue;
      const stock = stockMap[ingId];
      const canMake = stock && stock.currentStock >= add.consumesQuantity;
      if (add.available !== canMake) {
        await Additional.findByIdAndUpdate(add._id, { available: canMake });
        console.log(`📦 [Stock] Adicional "${add.name}" → ${canMake ? 'disponible' : 'sin stock'}`);
      }
    }
  } catch (err) {
    console.error('Error en autoUpdateAdditionalAvailability:', err.message);
  }
}

// ── Auto-actualizar disponibilidad de promos ──────────────────────────────────
// Una promo se apaga si cualquiera de sus productos componentes no está disponible.
async function autoUpdatePromoAvailability() {
  try {
    const Promo = require('../models/Promo');
    const promos = await Promo.find({ active: true });
    for (const promo of promos) {
      let available = true;
      for (const c of promo.components) {
        const prod = await Product.findById(c.product).select('available active');
        if (!prod || !prod.active || !prod.available) { available = false; break; }
      }
      if (promo.available !== available) {
        await Promo.findByIdAndUpdate(promo._id, { available });
        console.log(`🎁 [Stock] Promo "${promo.name}" → ${available ? 'disponible' : 'sin stock'}`);
      }
    }
  } catch (err) {
    console.error('Error en autoUpdatePromoAvailability:', err.message);
  }
}

// ── Devolver stock al cancelar un pedido ─────────────────────────────────────
async function returnStockForOrder(orderItems) {
  const Additional = require('../models/Additional');
  const additions = {};

  for (const item of orderItems) {
    // Ingredientes del producto base
    const product = await Product.findById(item.product).populate('recipe');
    if (product?.recipe) {
      const recipe = await Recipe.findById(product.recipe).populate('ingredients.ingredient');
      if (recipe) {
        for (const ri of recipe.ingredients) {
          const ingId = ri.ingredient._id.toString();
          additions[ingId] = (additions[ingId] || 0) + ri.quantity * item.quantity;
        }
      }
    }
    // Ingredientes de adicionales vinculados
    for (const a of (item.additionals || [])) {
      const add = await Additional.findById(a.additional || a._id);
      if (!add?.ingredient) continue;
      const ingId = add.ingredient.toString();
      additions[ingId] = (additions[ingId] || 0) + add.consumesQuantity * (a.quantity || 1);
    }
  }

  for (const [ingredientId, quantity] of Object.entries(additions)) {
    const stock = await Stock.findOne({ ingredient: ingredientId });
    if (!stock) continue;
    stock.currentStock = stock.currentStock + quantity;
    await stock.save();
    console.log(`📦 [Stock] Devuelto ${quantity} de ingrediente ${ingredientId}`);
  }
}

module.exports = {
  reserveStockForOrder,
  deductStockForOrder,
  calcPackagingForOrder,
  calcPackagingCost,
  recalculateProductCosts,
  generateShoppingList,
  generateProductionShoppingList,
  autoUpdateProductAvailability,
  autoUpdateAdditionalAvailability,
  autoUpdatePromoAvailability,
  returnStockForOrder,
};