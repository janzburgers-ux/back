const { Order } = require('../models/Order');

const PLANCHA_CAPACITY = 20;   // medallones
const FREIDORA_CAPACITY = 7;   // porciones de papas

const COOK_TIME_MIN = 9;       // minutos promedio en plancha
const ASSEMBLE_TIME = 3;       // armado
const PACK_TIME = 2;           // empaque
const FRY_TIME = 6;            // freidora

const TOTAL_COOK_TIME = COOK_TIME_MIN + ASSEMBLE_TIME + PACK_TIME; // 14 min

// Calcular medallones y porciones que usa un pedido
function calcOrderLoad(items) {
  let medallones = 0;
  let papas = 0;
  for (const item of items) {
    const variant = (item.variant || '').toLowerCase();
    const qty = item.quantity || 1;
    let medallonesPorUnidad = 1;
    if (variant.includes('x2') || variant === 'x2') medallonesPorUnidad = 2;
    if (variant.includes('x3') || variant === 'x3') medallonesPorUnidad = 3;
    medallones += medallonesPorUnidad * qty;
    papas += qty; // 1 porción por hamburguesa (combo)
  }
  return { medallones, papas };
}

// Obtener carga actual de la cocina (pedidos en estado 'preparing')
async function getCurrentLoad() {
  const preparingOrders = await Order.find({ status: 'preparing' });
  let totalMedallones = 0;
  let totalPapas = 0;
  for (const order of preparingOrders) {
    const load = calcOrderLoad(order.items);
    totalMedallones += load.medallones;
    totalPapas += load.papas;
  }
  return {
    medallones: totalMedallones,
    papas: totalPapas,
    planchaOccupied: totalMedallones,
    planchaFree: Math.max(0, PLANCHA_CAPACITY - totalMedallones),
    freidoraOccupied: totalPapas,
    freidoraFree: Math.max(0, FREIDORA_CAPACITY - totalPapas),
    planchaPercent: Math.round((totalMedallones / PLANCHA_CAPACITY) * 100),
    freidoraPercent: Math.round((totalPapas / FREIDORA_CAPACITY) * 100),
    isSaturated: totalMedallones >= PLANCHA_CAPACITY * 0.8 || totalPapas >= FREIDORA_CAPACITY * 0.8
  };
}

// Estimar tiempo de espera para un nuevo pedido
async function estimateWaitTime(newOrderItems, scheduledFor = null) {
  const load = await getCurrentLoad();
  const newLoad = calcOrderLoad(newOrderItems);

  // Si hay lugar en ambas → entra directo
  const fitsInPlancha = newLoad.medallones <= load.planchaFree;
  const fitsInFreidora = newLoad.papas <= load.freidoraFree;

  let waitMinutes = 0;

  if (!fitsInPlancha || !fitsInFreidora) {
    // No entra todo junto — hay que esperar lotes
    // Estimamos que el lote actual se libera en TOTAL_COOK_TIME / 2 (ya llevan un rato)
    waitMinutes = Math.ceil(TOTAL_COOK_TIME / 2);
  }

  const cookTime = Math.max(TOTAL_COOK_TIME, FRY_TIME); // cuello de botella
  const totalMinutes = waitMinutes + cookTime;

  const now = new Date();
  const readyAt = new Date(now.getTime() + totalMinutes * 60000);

  // Sumar tiempo de delivery estimado (15 min default)
  const deliveryTime = 15;
  const deliveryAt = new Date(readyAt.getTime() + deliveryTime * 60000);

  return {
    waitMinutes,
    cookMinutes: cookTime,
    totalMinutes,
    readyAt,
    deliveryAt,
    load,
    newLoad,
    fitsInPlancha,
    fitsInFreidora
  };
}

// Formatear hora Argentina
function formatTimeAR(date) {
  return new Date(date).toLocaleTimeString('es-AR', {
    hour: '2-digit', minute: '2-digit',
    timeZone: 'America/Argentina/Buenos_Aires'
  });
}

module.exports = {
  calcOrderLoad,
  getCurrentLoad,
  estimateWaitTime,
  formatTimeAR,
  PLANCHA_CAPACITY,
  FREIDORA_CAPACITY,
  TOTAL_COOK_TIME
};
