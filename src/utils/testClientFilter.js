const { Client } = require('../models/Order');

/**
 * Devuelve un filtro de MongoDB que excluye pedidos de clientes de prueba.
 * Uso: const filter = await noTestFilter();
 *      Order.find({ ...filter, status: 'delivered' })
 */
async function noTestFilter() {
  try {
    const testClients = await Client.find({ isTestClient: true }).distinct('_id');
    if (!testClients.length) return {};
    return { client: { $nin: testClients } };
  } catch {
    return {};
  }
}

module.exports = { noTestFilter };
