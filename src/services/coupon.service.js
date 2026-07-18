// ── Motor único de elegibilidad de cupones ────────────────────────────────
// Antes esta lógica estaba duplicada (y desincronizada) entre:
//   - routes/coupons.js  (/validate, preview que ve el cliente en el checkout)
//   - routes/public.js   (POST /order, creación real del pedido)
//   - routes/orders.js   (POST /admin-create)
// El preview no chequeaba `ownerOnly`, no chequeaba `blockedOwnerUse` para
// cupones que no son de tipo 'referral', y no chequeaba `maxUses`. Resultado:
// el cliente veía "cupón válido" en el checkout pero al crear el pedido de
// verdad esas reglas SÍ se aplicaban y el cupón se caía en silencio.
//
// A partir de ahora TODOS los puntos de entrada llaman a esta única función,
// así nunca más se pueden desincronizar.

const { Client, Order } = require('../models/Order');

function normPhone(p) {
  return (p || '').replace(/\D/g, '');
}

/**
 * Chequea si un cupón es elegible para un WhatsApp dado.
 * Solo lectura — no reserva ni descuenta nada (eso lo hace quien la llama).
 *
 * @returns {Promise<{ok:true} | {ok:false, reason:string, message:string}>}
 */
async function checkCouponEligibility(coupon, whatsapp) {
  if (!coupon || !coupon.active) {
    return { ok: false, reason: 'inactive', message: 'Cupón inválido o inactivo' };
  }

  if (coupon.expiresAt && new Date() > new Date(coupon.expiresAt)) {
    return { ok: false, reason: 'expired', message: 'Este cupón está vencido' };
  }

  const client = await Client.findOne({ whatsapp, active: true });

  // ── Referido: 1 solo uso por cliente, sin importar 'unlimited' ──────────
  if (coupon.type === 'referral' && client) {
    const alreadyUsed = coupon.uses.some(u => u.client?.toString() === client._id.toString());
    if (alreadyUsed) {
      return { ok: false, reason: 'alreadyUsed', message: 'Ya utilizaste este cupón anteriormente' };
    }
  }

  // ── El dueño no puede usar su propio cupón ───────────────────────────────
  // FIX: antes esto solo se chequeaba para type === 'referral' en el preview.
  // blockedOwnerUse puede estar en cualquier tipo de cupón con owner asignado.
  if (coupon.blockedOwnerUse && coupon.owner) {
    const owner = await Client.findById(coupon.owner).select('whatsapp');
    const ownerPhone = normPhone(owner?.whatsapp);
    const userPhone = normPhone(whatsapp);
    if (ownerPhone && ownerPhone === userPhone) {
      return { ok: false, reason: 'ownerBlocked', message: 'No podés usar tu propio cupón' };
    }
  }

  // ── ownerOnly: cupón exclusivo del dueño (ej: premios Prode) ────────────
  // FIX: esto no se chequeaba nunca en el preview.
  if (coupon.ownerOnly) {
    const owner = await Client.findById(coupon.owner).select('whatsapp');
    const ownerPhone = normPhone(owner?.whatsapp);
    const userPhone = normPhone(whatsapp);
    if (!ownerPhone || ownerPhone !== userPhone) {
      return { ok: false, reason: 'ownerOnly', message: 'Este cupón es exclusivo para otro cliente' };
    }
  }

  // ── No unlimited → ya usado por este cliente en un pedido no cancelado ──
  if (!coupon.unlimited && client) {
    const existingOrder = await Order.findOne({
      coupon: coupon._id, client: client._id, status: { $ne: 'cancelled' }
    });
    if (existingOrder) {
      return { ok: false, reason: 'alreadyUsed', message: 'Ya usaste este cupón anteriormente' };
    }
  }

  // ── singleUse: nadie más lo debe haber usado todavía ─────────────────────
  if (coupon.singleUse) {
    const anyActiveOrder = await Order.findOne({ coupon: coupon._id, status: { $ne: 'cancelled' } });
    if (anyActiveOrder) {
      return { ok: false, reason: 'singleUseTaken', message: 'Este cupón ya fue utilizado' };
    }
  }

  // ── maxUses: tope de usos globales (ej: premio 2do puesto Prode = 2 usos) ─
  // FIX: esto no se chequeaba nunca en el preview.
  if (coupon.maxUses) {
    const usesCount = await Order.countDocuments({ coupon: coupon._id, status: { $ne: 'cancelled' } });
    if (usesCount >= coupon.maxUses) {
      return { ok: false, reason: 'maxUses', message: 'Este cupón alcanzó el límite de usos' };
    }
  }

  return { ok: true };
}

module.exports = { checkCouponEligibility, normPhone };
