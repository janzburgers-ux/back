// Script de migración — correr UNA SOLA VEZ al desplegar el fix de la race
// condition en orderNumber (ver models/Counter.js y models/Order.js).
//
// Por qué hace falta: el contador atómico arranca en 0 si no existe. Si no lo
// inicializamos con el último número ya usado, el próximo pedido sería
// JANZ-0001 y probablemente ya exista → explota con E11000 al primer pedido
// post-deploy. Este script lo deja apuntando al último número real.
//
// Uso:
//   node src/config/init-order-counter.js
require('dotenv').config();
const mongoose = require('mongoose');
const { Order } = require('../models/Order');
const { Counter } = require('../models/Counter');

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('🔌 Conectado a MongoDB');

  const last = await Order.findOne({}, { orderNumber: 1 }).sort({ createdAt: -1 });
  let lastNum = 0;
  if (last?.orderNumber) {
    const match = last.orderNumber.match(/(\d+)$/);
    if (match) lastNum = parseInt(match[1], 10);
  }

  const counter = await Counter.findOneAndUpdate(
    { _id: 'orderNumber' },
    { $set: { seq: lastNum } },
    { upsert: true, new: true }
  );

  console.log(`✅ Counter 'orderNumber' inicializado en ${counter.seq}.`);
  console.log(`   El próximo pedido será JANZ-${String(counter.seq + 1).padStart(4, '0')}.`);

  await mongoose.disconnect();
}

run().catch(err => {
  console.error('❌ Error inicializando el counter:', err.message);
  process.exit(1);
});
