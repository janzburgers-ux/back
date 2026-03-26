/**
 * clear-orders.js
 *
 * Borra SOLO los pedidos y clientes de prueba.
 * ✅ CONSERVA: Usuarios, productos, ingredientes, stock, adicionales, cupones
 * 🗑️ BORRA:    Pedidos, clientes
 *
 * Uso: node src/config/clear-orders.js
 */
 
require('dotenv').config();
const mongoose = require('mongoose');
const { Client, Order } = require('../models/Order');
 
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/janzburgers';
 
async function clearOrders() {
  await mongoose.connect(MONGODB_URI);
  console.log('✅ Conectado a MongoDB...\n');
 
  const orderCount = await Order.countDocuments();
  const clientCount = await Client.countDocuments();
 
  console.log(`📋 Pedidos encontrados:  ${orderCount}`);
  console.log(`👥 Clientes encontrados: ${clientCount}\n`);
 
  await Order.deleteMany({});
  console.log('🗑️  Pedidos eliminados');
 
  await Client.deleteMany({});
  console.log('🗑️  Clientes eliminados');
 
  console.log('\n🎉 Listo! La app está limpia para empezar en producción.');
  console.log('   Usuarios, productos, stock y adicionales sin cambios.\n');
 
  await mongoose.disconnect();
}
 
clearOrders().catch(err => {
  console.error('❌ Error:', err);
  process.exit(1);
});