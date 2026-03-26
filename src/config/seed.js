require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');
const Ingredient = require('../models/Ingredient');
const Stock = require('../models/Stock');
const { Product } = require('../models/Product');
const Additional = require('../models/Additional');

const MONGODB_URI = process.env.MONGODB_URI;

async function seed() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log('✅ MongoDB conectado');

    // ── Limpiar colecciones ──────────────────────────────────────────────────
    await mongoose.connection.collection('users').deleteMany({});
    await mongoose.connection.collection('clients').deleteMany({});
    await mongoose.connection.collection('orders').deleteMany({});
    await mongoose.connection.collection('rejectedorders').deleteMany({});
    await mongoose.connection.collection('ingredients').deleteMany({});
    await mongoose.connection.collection('stocks').deleteMany({});
    await mongoose.connection.collection('products').deleteMany({});
    await mongoose.connection.collection('additionals').deleteMany({});
    await mongoose.connection.collection('recipes').deleteMany({});
    console.log('🗑️  Colecciones limpiadas');

    // ── Usuarios ─────────────────────────────────────────────────────────────
    const usersData = [
      { name: 'Gianf', email: 'gianbuzzelatto@gmail.com', password: '26062020', role: 'admin', active: true, profitShare: 0 },
      { name: 'Zai',   email: 'zaibuzzelatto@gmail.com',  password: '28102006', role: 'admin', active: true, profitShare: 0 },
    ];
    for (const u of usersData) {
      const user = new User(u);
      await user.save();
      console.log(`✅ Usuario: ${user.email}`);
    }

    // ── Ingredientes ─────────────────────────────────────────────────────────
    const ingredientsData = [
      { name: 'Carne picada',     unit: 'g',      packageUnit: 'kg',          quantityPerPackage: 1000,  packageCost: 13000, category: 'Proteína',     perishable: true,  priority: 'A' },
      { name: 'Panceta',          unit: 'g',      packageUnit: '100g',         quantityPerPackage: 100,   packageCost: 2000,  category: 'Proteína',     perishable: true,  priority: 'A' },
      { name: 'Huevo',            unit: 'unidad', packageUnit: 'maple x30',    quantityPerPackage: 30,    packageCost: 4000,  category: 'Proteína',     perishable: true,  priority: 'A' },
      { name: 'Cheddar en fetas', unit: 'feta',   packageUnit: 'barra x192',   quantityPerPackage: 192,   packageCost: 38000, category: 'Lácteos',      perishable: true,  priority: 'A' },
      { name: 'Cheddar líquido',  unit: 'g',      packageUnit: 'pote 1.5kg',   quantityPerPackage: 1500,  packageCost: 20000, category: 'Lácteos',      perishable: true,  priority: 'A' },
      { name: 'Leche en polvo',   unit: 'g',      packageUnit: 'bolsa 800g',   quantityPerPackage: 800,   packageCost: 13000, category: 'Lácteos',      perishable: false, priority: 'B' },
      { name: 'Manteca',          unit: 'g',      packageUnit: '200g',         quantityPerPackage: 200,   packageCost: 4000,  category: 'Lácteos',      perishable: true,  priority: 'B' },
      { name: 'Tomate',           unit: 'unidad', packageUnit: 'unidad',       quantityPerPackage: 1,     packageCost: 250,   category: 'Verduras',     perishable: true,  priority: 'A' },
      { name: 'Cebolla',          unit: 'unidad', packageUnit: 'unidad',       quantityPerPackage: 1,     packageCost: 250,   category: 'Verduras',     perishable: true,  priority: 'A' },
      { name: 'Lechuga',          unit: 'planta', packageUnit: 'planta',       quantityPerPackage: 1,     packageCost: 250,   category: 'Verduras',     perishable: true,  priority: 'A' },
      { name: 'Papas fritas',     unit: 'g',      packageUnit: 'bolsa 15kg',   quantityPerPackage: 15000, packageCost: 70000, category: 'Almacén',      perishable: false, priority: 'A' },
      { name: 'Aceite',           unit: 'ml',     packageUnit: 'bidón 5L',     quantityPerPackage: 5000,  packageCost: 17000, category: 'Almacén',      perishable: false, priority: 'B' },
      { name: 'Harina',           unit: 'g',      packageUnit: 'kg',           quantityPerPackage: 1000,  packageCost: 1200,  category: 'Almacén',      perishable: false, priority: 'B' },
      { name: 'Azúcar',           unit: 'g',      packageUnit: 'kg',           quantityPerPackage: 1000,  packageCost: 1200,  category: 'Almacén',      perishable: false, priority: 'C' },
      { name: 'Sal',              unit: 'g',      packageUnit: 'kg',           quantityPerPackage: 1000,  packageCost: 700,   category: 'Almacén',      perishable: false, priority: 'C' },
      { name: 'Puré de papa',     unit: 'sobre',  packageUnit: 'sobre',        quantityPerPackage: 1,     packageCost: 500,   category: 'Almacén',      perishable: false, priority: 'B' },
      { name: 'Levadura seca',    unit: 'g',      packageUnit: 'sobre 20g',    quantityPerPackage: 20,    packageCost: 1000,  category: 'Almacén',      perishable: false, priority: 'B' },
      { name: 'Mayonesa',         unit: 'g',      packageUnit: 'kg',           quantityPerPackage: 1,     packageCost: 3000,  category: 'Salsas',       perishable: false, priority: 'B' },
      { name: 'Ketchup',          unit: 'g',      packageUnit: 'kg',           quantityPerPackage: 1,     packageCost: 3000,  category: 'Salsas',       perishable: false, priority: 'B' },
      { name: 'Mostaza',          unit: 'g',      packageUnit: 'kg',           quantityPerPackage: 1,     packageCost: 3000,  category: 'Salsas',       perishable: false, priority: 'B' },
      { name: 'Bolsas',           unit: 'unidad', packageUnit: 'paquete x50',  quantityPerPackage: 50,    packageCost: 6000,  category: 'Descartables', perishable: false, priority: 'C' },
      { name: 'Bandejitas papas', unit: 'unidad', packageUnit: 'paquete x100', quantityPerPackage: 100,   packageCost: 6000,  category: 'Descartables', perishable: false, priority: 'C' },
      { name: 'Papel aluminio',   unit: 'unidad', packageUnit: 'rollo',        quantityPerPackage: 100,   packageCost: 10000, category: 'Descartables', perishable: false, priority: 'C' },
    ];

    const ingredients = [];
    for (const data of ingredientsData) {
      const ing = new Ingredient(data);
      await ing.save();
      ingredients.push(ing);
    }
    console.log(`✅ ${ingredients.length} ingredientes creados`);

    // Helper
    const findIng = (name) => ingredients.find(i => i.name === name);

    // ── Stock ─────────────────────────────────────────────────────────────────
    const stockData = [
      { ingredient: 'Carne picada',     currentStock: 0,    minimumStock: 5000, unit: 'g' },
      { ingredient: 'Cheddar en fetas', currentStock: 0,    minimumStock: 48,   unit: 'fetas' },
      { ingredient: 'Cheddar líquido',  currentStock: 0,    minimumStock: 1000, unit: 'g' },
      { ingredient: 'Papas fritas',     currentStock: 2000, minimumStock: 7500, unit: 'g' },
      { ingredient: 'Huevo',            currentStock: 30,   minimumStock: 10,   unit: 'unidades' },
      { ingredient: 'Panceta',          currentStock: 500,  minimumStock: 500,  unit: 'g' },
      { ingredient: 'Harina',           currentStock: 3000, minimumStock: 2600, unit: 'g' },
      { ingredient: 'Manteca',          currentStock: 300,  minimumStock: 200,  unit: 'g' },
      { ingredient: 'Levadura seca',    currentStock: 30,   minimumStock: 20,   unit: 'g' },
      { ingredient: 'Puré de papa',     currentStock: 2,    minimumStock: 2,    unit: 'sobres' },
      { ingredient: 'Leche en polvo',   currentStock: 400,  minimumStock: 100,  unit: 'g' },
      { ingredient: 'Azúcar',           currentStock: 400,  minimumStock: 100,  unit: 'g' },
      { ingredient: 'Sal',              currentStock: 0,    minimumStock: 50,   unit: 'g' },
      { ingredient: 'Mayonesa',         currentStock: 1,    minimumStock: 1,    unit: 'unidades' },
      { ingredient: 'Ketchup',          currentStock: 0,    minimumStock: 1,    unit: 'unidades' },
      { ingredient: 'Mostaza',          currentStock: 1,    minimumStock: 1,    unit: 'unidades' },
      { ingredient: 'Bolsas',           currentStock: 80,   minimumStock: 35,   unit: 'unidades' },
      { ingredient: 'Tomate',           currentStock: 1,    minimumStock: 2,    unit: 'unidades' },
      { ingredient: 'Cebolla',          currentStock: 1,    minimumStock: 4,    unit: 'unidades' },
      { ingredient: 'Lechuga',          currentStock: 1,    minimumStock: 1,    unit: 'plantas' },
      { ingredient: 'Aceite',           currentStock: 0,    minimumStock: 500,  unit: 'ml' },
      { ingredient: 'Bandejitas papas', currentStock: 80,   minimumStock: 35,   unit: 'unidades' },
      { ingredient: 'Papel aluminio',   currentStock: 80,   minimumStock: 35,   unit: 'unidades' },
    ];

    for (const sd of stockData) {
  const ing = findIng(sd.ingredient);
  if (!ing) continue;
  const { ingredient, ...rest } = sd;
  const stock = new Stock({ ingredient: ing._id, ...rest });
  await stock.save();
}
    console.log('✅ Stock inicial cargado');

    // ── Adicionales ───────────────────────────────────────────────────────────
    const additionalsData = [
      { name: 'Panceta extra',        description: '50g de panceta crocante',    price: 2000, emoji: '🥓' },
      { name: 'Huevo frito',          description: 'Huevo frito a punto',        price: 1500, emoji: '🍳' },
      { name: 'Cheddar extra',        description: '2 fetas de cheddar',         price: 1500, emoji: '🧀' },
      { name: 'Cheddar líquido',      description: 'Salsa de cheddar',           price: 1200, emoji: '🫕' },
      { name: 'Cebolla caramelizada', description: 'Cebolla pochada al vino',    price: 1000, emoji: '🧅' },
      { name: 'Papas fritas extra',   description: 'Porción adicional de papas', price: 3000, emoji: '🍟' },
    ];

    for (const ad of additionalsData) {
      const additional = new Additional(ad);
      await additional.save();
    }
    console.log(`✅ ${additionalsData.length} adicionales creados`);

    // ── Productos ─────────────────────────────────────────────────────────────
    const productsData = [
      { name: 'Cheeseburger', variant: 'Simple', salePrice: 10000, description: 'PAN DE PAPA ARTESANAL + MEDALLON 100GR + CHEDDAR + PORCION DE PAPAS', available: true },
      { name: 'Cheeseburger', variant: 'Doble',  salePrice: 12000, description: 'PAN DE PAPA ARTESANAL + MEDALLON 100GR + CHEDDAR + PORCION DE PAPAS', available: true },
      { name: 'Cheeseburger', variant: 'Triple', salePrice: 14000, description: 'PAN DE PAPA ARTESANAL + MEDALLON 100GR + CHEDDAR + PORCION DE PAPAS', available: true },
      { name: 'Clasicona',    variant: 'Simple', salePrice: 11000, description: 'PAN DE PAPA ARTESANAL + MEDALLON 100GR + CHEDDAR + LECHUGA + TOMATE + PORCION DE PAPAS', available: true },
      { name: 'Clasicona',    variant: 'Doble',  salePrice: 13000, description: 'PAN DE PAPA ARTESANAL + MEDALLON 100GR + CHEDDAR + LECHUGA + TOMATE + PORCION DE PAPAS', available: true },
      { name: 'Clasicona',    variant: 'Triple', salePrice: 15000, description: 'PAN DE PAPA ARTESANAL + MEDALLON 100GR + CHEDDAR + LECHUGA + TOMATE + PORCION DE PAPAS', available: true },
      { name: 'Janz',         variant: 'Simple', salePrice: 11000, description: 'PAN DE PAPA ARTESANAL + MEDALLON 100GR + CHEDDAR + CEBOLLA CRISPY + PORCION DE PAPAS', available: true },
      { name: 'Janz',         variant: 'Doble',  salePrice: 13000, description: 'PAN DE PAPA ARTESANAL + MEDALLON 100GR + CHEDDAR + CEBOLLA CRISPY + PORCION DE PAPAS', available: true },
      { name: 'Janz',         variant: 'Triple', salePrice: 16000, description: 'PAN DE PAPA ARTESANAL + MEDALLON 100GR + CHEDDAR + CEBOLLA CRISPY + PORCION DE PAPAS', available: true },
      { name: 'Cava',         variant: 'Simple', salePrice: 13000, description: 'PAN DE PAPA ARTESANAL + MEDALLON 100GR + CHEDDAR + HUEVO FRITO + EXTRA PANCETA + PORCION DE PAPAS', available: true },
      { name: 'Cava',         variant: 'Doble',  salePrice: 16000, description: 'PAN DE PAPA ARTESANAL + MEDALLON 100GR + CHEDDAR + HUEVO FRITO + EXTRA PANCETA + PORCION DE PAPAS', available: true },
      { name: 'Cava',         variant: 'Triple', salePrice: 19000, description: 'PAN DE PAPA ARTESANAL + MEDALLON 100GR + CHEDDAR + HUEVO FRITO + EXTRA PANCETA + PORCION DE PAPAS', available: true },
      { name: 'Smash Onion',  variant: 'Simple', salePrice: 12000, description: 'PAN DE PAPA ARTESANAL + CARNE SMASH CON CEBOLLA + CHEDDAR + PORCION DE PAPAS', available: true },
      { name: 'Smash Onion',  variant: 'Doble',  salePrice: 14000, description: 'PAN DE PAPA ARTESANAL + CARNE SMASH CON CEBOLLA + CHEDDAR + PORCION DE PAPAS', available: true },
      { name: 'Smash Onion',  variant: 'Triple', salePrice: 16000, description: 'PAN DE PAPA ARTESANAL + CARNE SMASH CON CEBOLLA + CHEDDAR + PORCION DE PAPAS', available: true },
    ];

    for (const pd of productsData) {
      const product = new Product(pd);
      await product.save();
    }
    console.log(`✅ ${productsData.length} productos creados`);

    console.log('\n🎉 Seed completado exitosamente!');
    process.exit(0);
  } catch (err) {
    console.error('❌ Error:', err);
    process.exit(1);
  }
}

seed();