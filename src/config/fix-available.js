/**
 * fix-additionals.js
 * - Elimina: Cebolla caramelizada, Cheddar líquido
 * - Agrega: Medallón de 100gr ($3000)
 * Uso: node src/config/fix-additionals.js
 */
 
require('dotenv').config();
const mongoose = require('mongoose');
const Additional = require('../models/Additional');
 
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/janzburgers';
 
async function fixAdditionals() {
  await mongoose.connect(MONGODB_URI);
  console.log('✅ Conectado a MongoDB...');
 
  // Eliminar
  const deleted = await Additional.deleteMany({
    name: { $in: ['Cebolla caramelizada', 'Cheddar líquido'] }
  });
  console.log(`🗑️  ${deleted.deletedCount} adicionales eliminados`);
 
  // Agregar medallón
  const existing = await Additional.findOne({ name: 'Medallón de 100gr' });
  if (!existing) {
    await new Additional({
      name: 'Medallón de 100gr',
      description: 'Medallón extra de carne de 100gr',
      price: 3000,
      emoji: '🥩',
      active: true
    }).save();
    console.log('✅ Medallón de 100gr agregado');
  } else {
    console.log('⚠️  Medallón de 100gr ya existe');
  }
 
  console.log('🎉 Listo!');
  await mongoose.disconnect();
}
 
fixAdditionals().catch(err => {
  console.error('❌ Error:', err);
  process.exit(1);
});
 