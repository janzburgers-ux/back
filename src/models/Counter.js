const mongoose = require('mongoose');

// ── Counter: secuencias atómicas (ej: orderNumber) ────────────────────────────
// FIX bug "error al enviar pedido": antes, el número de pedido se generaba
// buscando el último pedido guardado y sumándole 1 a mano (ver git blame de
// Order.js). Esa lógica de "leer último + sumar 1" NO es atómica: si dos
// pedidos se guardan casi al mismo tiempo (ej: dos clientes mandando su pedido
// en simultáneo, típico en una previa de Mundial), ambos pueden leer el mismo
// "último número" y calcular el MISMO siguiente número. orderNumber tiene un
// índice unique, así que el segundo de los dos guardados explota con un
// E11000 duplicate key error → el pedido de ese cliente queda sin guardar y
// ve un error genérico al enviar.
//
// findOneAndUpdate con $inc es atómico a nivel de documento en MongoDB: dos
// pedidos guardándose en simultáneo SIEMPRE obtienen números consecutivos
// distintos, sin importar el timing exacto.
const counterSchema = new mongoose.Schema({
  _id: { type: String, required: true }, // nombre de la secuencia, ej: 'orderNumber'
  seq: { type: Number, default: 0 },
});

const Counter = mongoose.model('Counter', counterSchema);

async function getNextSequence(name) {
  const counter = await Counter.findOneAndUpdate(
    { _id: name },
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  return counter.seq;
}

module.exports = { Counter, getNextSequence };
