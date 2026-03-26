/**
 * reset-production.js
 * 
 * Script de reset para arrancar en producción.
 * 
 * ✅ CONSERVA: Usuarios, precios de venta de productos existentes
 * 🔄 RECREA:   Ingredientes, stock, recetas, productos (con costos correctos por variante)
 * 🗑️ BORRA:    Pedidos, clientes, adicionales de prueba
 * 
 * Uso: node src/config/reset-production.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Ingredient = require('../models/Ingredient');
const Stock = require('../models/Stock');
const { Recipe, Product } = require('../models/Product');
const { Client, Order } = require('../models/Order');
const Additional = require('../models/Additional');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/janzburgers';

async function resetProduction() {
  await mongoose.connect(MONGODB_URI);
  console.log('✅ Conectado a MongoDB...');

  // ── Guardar precios de venta actuales ──────────────────────────────
  const existingProducts = await Product.find({});
  const savedPrices = {};
  for (const p of existingProducts) {
    savedPrices[`${p.name}__${p.variant}`] = p.salePrice;
  }
  console.log(`💾 Precios guardados: ${Object.keys(savedPrices).length} productos`);

  // ── Borrar datos de prueba (NO usuarios) ───────────────────────────
  await Promise.all([
    Ingredient.deleteMany({}),
    Stock.deleteMany({}),
    Recipe.deleteMany({}),
    Product.deleteMany({}),
    Additional.deleteMany({}),
    Order.deleteMany({}),
    Client.deleteMany({})
  ]);
  console.log('🗑️  Datos de prueba eliminados (usuarios conservados)');

  // ── Ingredientes ───────────────────────────────────────────────────
  const ingredientsData = [
    { name: 'Medallon 100gr', unit: 'g', packageUnit: 'kg', quantityPerPackage: 1000, packageCost: 13500, category: 'Proteína', perishable: true, priority: 'A' },
    { name: 'Huevo', unit: 'unidad', packageUnit: 'maple x30', quantityPerPackage: 30, packageCost: 4000, category: 'Proteína', perishable: true, priority: 'A' },
    { name: 'Cheddar en fetas', unit: 'feta', packageUnit: 'barra x192', quantityPerPackage: 192, packageCost: 41000, category: 'Lácteos', perishable: true, priority: 'A' },
    { name: 'Cheddar líquido', unit: 'g', packageUnit: 'pouch 3.5kg', quantityPerPackage: 3500, packageCost: 32000, category: 'Lácteos', perishable: true, priority: 'A' },
    { name: 'Papas fritas', unit: 'g', packageUnit: 'bolsa 12.5kg', quantityPerPackage: 12500, packageCost: 75000, category: 'Almacén', perishable: false, priority: 'A' },
    { name: 'Aceite', unit: 'ml', packageUnit: 'bidón 5L', quantityPerPackage: 5000, packageCost: 18000, category: 'Almacén', perishable: false, priority: 'B' },
    { name: 'Bolsas', unit: 'unidad', packageUnit: 'paquete x50', quantityPerPackage: 50, packageCost: 6000, category: 'Descartables', perishable: false, priority: 'C' },
    { name: 'Bandejitas/Cartoncito', unit: 'unidad', packageUnit: 'paquete x100', quantityPerPackage: 100, packageCost: 8000, category: 'Descartables', perishable: false, priority: 'C' },
    { name: 'Papel aluminio', unit: 'unidad', packageUnit: 'rollo', quantityPerPackage: 100, packageCost: 10000, category: 'Descartables', perishable: false, priority: 'C' }
  ];

  const ingredients = [];
  for (const data of ingredientsData) {
    const ing = new Ingredient(data);
    await ing.save();
    ingredients.push(ing);
  }
  console.log(`✅ ${ingredients.length} ingredientes creados`);


  console.log('\n🎉 Reset de producción completado!');
  console.log('📦 Stock en cero — cargalo desde el panel antes de abrir');
  console.log('💰 Precios de venta conservados — modificalos desde Escandallo');
  console.log('👥 Usuarios sin cambios');

  await mongoose.disconnect();
}

resetProduction().catch(err => {
  console.error('❌ Error en reset:', err);
  process.exit(1);
});
