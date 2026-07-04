const { Order } = require('../models/Order');

const PLANCHA_CAPACITY  = 20;  // medallones simultáneos
const FREIDORA_CAPACITY = 7;   // porciones de papas simultáneas

const COOK_TIME_MIN  = 9;   // minutos en plancha
const ASSEMBLE_TIME  = 3;   // armado
const PACK_TIME      = 2;   // empaque
const FRY_TIME       = 6;   // freidora
const TOTAL_COOK_TIME = COOK_TIME_MIN + ASSEMBLE_TIME + PACK_TIME; // 14 min

// ── calcOrderLoad ─────────────────────────────────────────────────────────────
// Calcula cuántos medallones y porciones usa un pedido.
// Solo cuenta como "carga" los ítems que son hamburguesas (tienen variante
// con número de medallones). Bebidas, papas solas y adicionales no cargan la plancha.
function calcOrderLoad(items) {
  let medallones = 0;
  let papas      = 0;

  for (const item of (items || [])) {
    const name    = (item.productName || item.name || '').toLowerCase();
    const variant = (item.variant || '').toLowerCase();
    const qty     = item.quantity || 1;

    // Detectar si es una hamburguesa por variante o por nombre
    const isBurger =
      variant.includes('simple') || variant.includes('doble') ||
      variant.includes('triple') || variant.includes('x1') ||
      variant.includes('x2')     || variant.includes('x3') ||
      name.includes('burger') || name.includes('burguer') ||
      name.includes('cheese') || name.includes('smash') ||
      name.includes('promo');

    if (isBurger) {
      let medallonesPorUnidad = 1;
      if (variant.includes('doble') || variant.includes('x2')) medallonesPorUnidad = 2;
      if (variant.includes('triple') || variant.includes('x3')) medallonesPorUnidad = 3;
      medallones += medallonesPorUnidad * qty;
      papas      += qty; // las burgers vienen con papas
    }
    // Papas fritas solas (sin burger) — cuentan solo para freidora
    else if (name.includes('papas') || name.includes('fries')) {
      papas += qty;
    }
    // Bebidas, adicionales, etc. → no cargan plancha ni freidora
  }

  return { medallones, papas };
}

// ── getCurrentLoad ────────────────────────────────────────────────────────────
// FIX estimación de tiempo: antes solo se contaban los pedidos en 'preparing'.
// Los pedidos 'pending' y 'confirmed' también van a entrar a la cocina en
// pocos minutos — no contarlos hacía que el estimado dijera "14 min" aunque
// hubiera 5 pedidos esperando plancha. Ahora se incluyen todos los estados
// activos (pending, confirmed, preparing) en el cálculo de carga.
async function getCurrentLoad() {
  const activeOrders = await Order.find(
    { status: { $in: ['pending', 'confirmed', 'preparing'] } },
    { items: 1, status: 1 }   // proyección: solo campos necesarios
  ).lean();

  let totalMedallones = 0;
  let totalPapas      = 0;

  for (const order of activeOrders) {
    const load = calcOrderLoad(order.items);
    totalMedallones += load.medallones;
    totalPapas      += load.papas;
  }

  return {
    medallones:       totalMedallones,
    papas:            totalPapas,
    activeOrders:     activeOrders.length,
    planchaOccupied:  totalMedallones,
    planchaFree:      Math.max(0, PLANCHA_CAPACITY  - totalMedallones),
    freidoraOccupied: totalPapas,
    freidoraFree:     Math.max(0, FREIDORA_CAPACITY - totalPapas),
    planchaPercent:   Math.round((totalMedallones  / PLANCHA_CAPACITY)  * 100),
    freidoraPercent:  Math.round((totalPapas       / FREIDORA_CAPACITY) * 100),
    isSaturated:      totalMedallones >= PLANCHA_CAPACITY * 0.8 ||
                      totalPapas      >= FREIDORA_CAPACITY * 0.8,
  };
}

// ── estimateWaitTime ──────────────────────────────────────────────────────────
async function estimateWaitTime(newOrderItems, scheduledFor = null, deliveryMinutes = 15) {
  const load    = await getCurrentLoad();
  const newLoad = calcOrderLoad(newOrderItems);

  const fitsInPlancha  = newLoad.medallones <= load.planchaFree;
  const fitsInFreidora = newLoad.papas      <= load.freidoraFree;

  // Si no entra en la plancha/freidora, espera hasta que haya lugar
  // (aprox la mitad del tiempo de cocción del lote actual)
  let waitMinutes = (!fitsInPlancha || !fitsInFreidora)
    ? Math.ceil(TOTAL_COOK_TIME / 2)
    : 0;

  const cookTime      = Math.max(TOTAL_COOK_TIME, FRY_TIME);
  const totalMinutes  = waitMinutes + cookTime + deliveryMinutes;

  const now        = new Date();
  const readyAt    = new Date(now.getTime() + (waitMinutes + cookTime) * 60_000);
  const deliveryAt = new Date(readyAt.getTime() + deliveryMinutes * 60_000);

  return {
    waitMinutes,
    cookMinutes:     cookTime,
    deliveryMinutes,
    totalMinutes,
    readyAt,
    deliveryAt,
    load,
    newLoad,
    fitsInPlancha,
    fitsInFreidora,
  };
}

// ── formatTimeAR ──────────────────────────────────────────────────────────────
function formatTimeAR(date) {
  return new Date(date).toLocaleTimeString('es-AR', {
    hour: '2-digit', minute: '2-digit',
    timeZone: 'America/Argentina/Buenos_Aires',
  });
}

module.exports = {
  calcOrderLoad,
  getCurrentLoad,
  estimateWaitTime,
  formatTimeAR,
  PLANCHA_CAPACITY,
  FREIDORA_CAPACITY,
  TOTAL_COOK_TIME,
};
