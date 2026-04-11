const express = require('express');
const router  = express.Router();
const CashMovement = require('../models/CashMovement');
const { Order }    = require('../models/Order');
const Config       = require('../models/Config');
const { auth, adminOnly } = require('../middleware/auth');

// ── Helpers de período ────────────────────────────────────────────────────────

function getWeekId(date) {
  const d = new Date(date);
  const day = d.getDay();
  const offset = -((day - 5 + 7) % 7);
  const friday = new Date(d);
  friday.setDate(d.getDate() + offset);
  return friday.toISOString().split('T')[0];
}

// Dado un weekId (YYYY-MM-DD del viernes) devuelve rango Vie 00:00 → Dom 23:59
function weekRange(weekId) {
  const friday = new Date(weekId + 'T00:00:00-03:00');
  const sunday = new Date(friday);
  sunday.setDate(friday.getDate() + 2);
  sunday.setHours(23, 59, 59, 999);
  return { start: friday, end: sunday };
}

// Rango para un día (YYYY-MM-DD)
function dayRange(dateStr) {
  return {
    start: new Date(dateStr + 'T00:00:00-03:00'),
    end:   new Date(dateStr + 'T23:59:59.999-03:00')
  };
}

// Rango para un mes (YYYY-MM)
function monthRange(monthStr) {
  const [y, m] = monthStr.split('-').map(Number);
  return {
    start: new Date(y, m - 1, 1, 0, 0, 0),
    end:   new Date(y, m,     0, 23, 59, 59, 999)
  };
}

// Rango para un año
function yearRange(yearStr) {
  const y = Number(yearStr);
  return {
    start: new Date(y, 0,  1,  0,  0,  0),
    end:   new Date(y, 11, 31, 23, 59, 59, 999)
  };
}

// Parsea el rango según view y ref
function parseRange(view, ref) {
  if (view === 'dia')   return dayRange(ref);
  if (view === 'finde') return weekRange(ref);
  if (view === 'mes')   return monthRange(ref);
  if (view === 'año')   return yearRange(ref);
  return weekRange(getWeekId(new Date()));
}

// Devuelve la referencia por defecto para cada vista
function defaultRef(view) {
  const now = new Date();
  if (view === 'dia')   return now.toISOString().split('T')[0];
  if (view === 'finde') return getWeekId(now);
  if (view === 'mes')   return now.toISOString().slice(0, 7);
  if (view === 'año')   return String(now.getFullYear());
  return getWeekId(now);
}

// ── Obtener integrantes configurados ─────────────────────────────────────────
async function getMembers() {
  const cfg = await Config.findOne({ key: 'cashMembers' });
  return cfg?.value || [];
}

// ── Calcular ventas desde Orders ─────────────────────────────────────────────
async function getSalesInRange(start, end) {
  const orders = await Order.find({
    createdAt: { $gte: start, $lte: end },
    status: 'delivered'
  });

  let efectivo = 0, digital = 0;
  const movements = [];

  // Agrupar por día para mostrar en la lista
  const byDay = {};
  orders.forEach(o => {
    const dateStr = new Date(o.createdAt).toISOString().split('T')[0];
    if (!byDay[dateStr]) byDay[dateStr] = { efectivo: 0, digital: 0, count: 0 };
    if (o.paymentMethod === 'efectivo') {
      byDay[dateStr].efectivo += o.total;
      efectivo += o.total;
    } else {
      byDay[dateStr].digital += o.total;
      digital += o.total;
    }
    byDay[dateStr].count++;
  });

  Object.entries(byDay).sort().forEach(([date, data]) => {
    if (data.efectivo > 0) movements.push({
      _id: `sale-ef-${date}`, type: 'sale', isAuto: true,
      date, description: `Ventas efectivo`,
      amount: data.efectivo, direction: 'in', paymentMethod: 'efectivo',
      meta: `${data.count} pedido${data.count !== 1 ? 's' : ''}`
    });
    if (data.digital > 0) movements.push({
      _id: `sale-dg-${date}`, type: 'sale', isAuto: true,
      date, description: `Ventas transferencia`,
      amount: data.digital, direction: 'in', paymentMethod: 'digital',
      meta: `${data.count} pedido${data.count !== 1 ? 's' : ''}`
    });
  });

  return { efectivo, digital, total: efectivo + digital, movements };
}

// ── Calcular gastos desde Expenses ───────────────────────────────────────────
async function getExpensesInRange(start, end) {
  const startStr = start.toISOString().split('T')[0];
  const endStr   = end.toISOString().split('T')[0];

  // Importar directamente desde expenses para garantizar que el modelo esté registrado
  const mongoose = require('mongoose');
  let Expense;
  try {
    Expense = mongoose.model('Expense');
  } catch {
    // Si no está registrado todavía, requerirlo explícitamente
    require('./expenses'); // registra el modelo como efecto secundario
    Expense = mongoose.model('Expense');
  }

  const expenses = await Expense.find({ date: { $gte: startStr, $lte: endStr } });
  const total    = expenses.reduce((s, e) => s + e.amount, 0);
  const movements = expenses.map(e => ({
    _id: `exp-${e._id}`, type: 'expense', isAuto: true,
    date: e.date, description: e.description,
    amount: e.amount, direction: 'out', paymentMethod: 'efectivo',
    meta: e.category
  }));

  return { total, movements };
}

// ── GET /summary ─────────────────────────────────────────────────────────────
// Resumen completo del período: ventas, gastos, compras, retiros, ganancia, integrantes
router.get('/summary', auth, adminOnly, async (req, res) => {
  try {
    const view = req.query.view || 'finde';
    const ref  = req.query.ref  || defaultRef(view);
    const { start, end } = parseRange(view, ref);

    // Ventas (desde Orders)
    const sales = await getSalesInRange(start, end);

    // Gastos automáticos (desde Expenses)
    const expenses = await getExpensesInRange(start, end);

    // Movimientos manuales (compras, retiros, otros)
    const manuals = await CashMovement.find({
      date: { $gte: start, $lte: end }
    }).sort('date');

    const purchases   = manuals.filter(m => m.type === 'purchase');
    const withdrawals = manuals.filter(m => m.type === 'withdrawal');
    const others      = manuals.filter(m => m.type === 'other');

    const totalPurchases   = purchases.reduce((s, m)   => s + m.amount, 0);
    const totalWithdrawals = withdrawals.reduce((s, m) => s + m.amount, 0);
    const totalOthers      = others.reduce((s, m)      => s + m.amount, 0);

    // Ganancia neta = ventas − compras − gastos auto − otros
    const totalOut    = totalPurchases + expenses.total + totalOthers;
    const netProfit   = sales.total - totalOut;

    // Saldo en efectivo = ventas efectivo − egresos efectivo
    const outEfectivo = manuals
      .filter(m => m.paymentMethod === 'efectivo')
      .reduce((s, m) => s + m.amount, 0)
      + expenses.total; // gastos asumidos en efectivo
    const balanceEfectivo = sales.efectivo - outEfectivo;
    const balanceDigital  = sales.digital;

    // Integrantes y estado de retiros
    const members = await getMembers();
    const membersStatus = members.map(member => {
      const entitled   = Math.max(0, Math.round(netProfit * member.percent / 100));
      const withdrawn  = withdrawals
        .filter(m => m.memberId === member.id)
        .reduce((s, m) => s + m.amount, 0);
      const available  = Math.max(0, entitled - withdrawn);
      return { ...member, entitled, withdrawn, available };
    });

    // ── Métricas operativas para Objetivos de Caja ──────────────────────────
    const { Order: OrderModel } = require('../models/Order');
    const { Client: ClientModel } = require('../models/Order');

    // Pedidos totales no cancelados en el período
    const periodOrders = await OrderModel.find({
      createdAt: { $gte: start, $lte: end },
      status: { $ne: 'cancelled' }
    }).select('items coupon client createdAt total');

    const ordersCount  = periodOrders.length;
    const burgersCount = periodOrders.reduce((sum, o) =>
      sum + o.items.reduce((s, i) => s + (i.quantity || 0), 0), 0
    );
    const avgTicket    = ordersCount > 0 ? Math.round(sales.total / ordersCount) : 0;
    const couponsCount = periodOrders.filter(o => o.coupon).length;

    // Clientes nuevos y recurrentes en el período
    const newClientsCount = await ClientModel.countDocuments({
      createdAt: { $gte: start, $lte: end }
    });

    // Clientes recurrentes: ordenaron al menos 2 veces en total Y tuvieron orden en este período
    const clientsWithOrdersInPeriod = [...new Set(periodOrders.map(o => o.client?.toString()).filter(Boolean))];
    let returningCount = 0;
    if (clientsWithOrdersInPeriod.length > 0) {
      returningCount = await ClientModel.countDocuments({
        _id: { $in: clientsWithOrdersInPeriod },
        totalOrders: { $gte: 2 }
      });
    }

    res.json({
      period: { view, ref, start, end },
      sales: {
        efectivo: sales.efectivo,
        digital:  sales.digital,
        total:    sales.total
      },
      expenses:   { total: expenses.total },
      purchases:  { total: totalPurchases },
      others:     { total: totalOthers },
      withdrawals:{ total: totalWithdrawals },
      totalOut,
      netProfit,
      balanceEfectivo,
      balanceDigital,
      membersStatus,
      // ── Métricas operativas ─────────────────────────────────────────────
      metrics: {
        ordersCount,
        burgersCount,
        avgTicket,
        couponsCount,
        newClients:       newClientsCount,
        returningClients: returningCount
      }
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── GET /movements ────────────────────────────────────────────────────────────
// Lista de todos los movimientos del período (auto + manuales), cronológicos
router.get('/movements', auth, adminOnly, async (req, res) => {
  try {
    const view = req.query.view || 'finde';
    const ref  = req.query.ref  || defaultRef(view);
    const { start, end } = parseRange(view, ref);

    const [sales, expenses, manuals] = await Promise.all([
      getSalesInRange(start, end),
      getExpensesInRange(start, end),
      CashMovement.find({ date: { $gte: start, $lte: end } }).sort('date')
    ]);

    const manualMapped = manuals.map(m => ({
      _id:           m._id,
      type:          m.type,
      isAuto:        false,
      date:          m.date.toISOString().split('T')[0],
      description:   m.description,
      amount:        m.amount,
      direction:     'out',
      paymentMethod: m.paymentMethod,
      memberId:      m.memberId || null,
      notes:         m.notes,
      meta:          m.memberId ? `Retiro` : null
    }));

    const all = [
      ...sales.movements,
      ...expenses.movements,
      ...manualMapped
    ].sort((a, b) => a.date.localeCompare(b.date));

    res.json(all);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── POST / ────────────────────────────────────────────────────────────────────
// Crear movimiento manual (compra, retiro, otro)
router.post('/', auth, adminOnly, async (req, res) => {
  try {
    const { type, description, amount, paymentMethod, memberId, date, notes } = req.body;

    if (!['purchase', 'withdrawal', 'other'].includes(type))
      return res.status(400).json({ message: 'Tipo de movimiento inválido' });
    if (!description || !amount || amount <= 0)
      return res.status(400).json({ message: 'Descripción e importe son obligatorios' });

    // Si es retiro, validar que no supere el disponible del integrante
    if (type === 'withdrawal' && memberId) {
      const members = await getMembers();
      const member  = members.find(m => m.id === memberId);
      if (member) {
        const movDate = new Date(date || Date.now());
        const { start, end } = weekRange(getWeekId(movDate));

        const [sales, expenses, prevManuals] = await Promise.all([
          getSalesInRange(start, end),
          getExpensesInRange(start, end),
          CashMovement.find({ date: { $gte: start, $lte: end }, type: { $ne: 'withdrawal' } })
        ]);

        const totalOut   = prevManuals.reduce((s, m) => s + m.amount, 0) + expenses.total;
        const netProfit  = sales.total - totalOut;
        const entitled   = Math.max(0, Math.round(netProfit * member.percent / 100));

        const prevWithdrawn = await CashMovement.aggregate([
          { $match: { date: { $gte: start, $lte: end }, type: 'withdrawal', memberId } },
          { $group: { _id: null, total: { $sum: '$amount' } } }
        ]);
        const alreadyWithdrawn = prevWithdrawn[0]?.total || 0;
        const available        = entitled - alreadyWithdrawn;

        if (Number(amount) > available) {
          return res.status(400).json({
            message: `${member.name} solo puede retirar $${available.toLocaleString('es-AR')} (le corresponden $${entitled.toLocaleString('es-AR')}, ya retiró $${alreadyWithdrawn.toLocaleString('es-AR')})`
          });
        }
      }
    }

    const mov = new CashMovement({
      weekId: getWeekId(date || new Date()),
      date:   date ? new Date(date) : new Date(),
      type, description, amount: Number(amount),
      paymentMethod: paymentMethod || 'efectivo',
      memberId: memberId || null,
      notes: notes || ''
    });
    await mov.save();
    res.status(201).json(mov);
  } catch (err) { res.status(400).json({ message: err.message }); }
});

// ── DELETE /:id ───────────────────────────────────────────────────────────────
router.delete('/:id', auth, adminOnly, async (req, res) => {
  try {
    const mov = await CashMovement.findById(req.params.id);
    if (!mov) return res.status(404).json({ message: 'Movimiento no encontrado' });
    await mov.deleteOne();
    res.json({ message: 'Eliminado' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── GET /members ──────────────────────────────────────────────────────────────
router.get('/members', auth, adminOnly, async (req, res) => {
  try {
    const members = await getMembers();
    res.json(members);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── PUT /members ──────────────────────────────────────────────────────────────
router.put('/members', auth, adminOnly, async (req, res) => {
  try {
    const { members } = req.body;
    if (!Array.isArray(members))
      return res.status(400).json({ message: 'members debe ser un array' });

    const totalPct = members.reduce((s, m) => s + (Number(m.percent) || 0), 0);
    if (totalPct > 100)
      return res.status(400).json({ message: `Los porcentajes suman ${totalPct}% (máximo 100%)` });

    await Config.findOneAndUpdate(
      { key: 'cashMembers' },
      { key: 'cashMembers', value: members },
      { upsert: true, new: true }
    );
    res.json({ members, totalPct });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── GET /periods ──────────────────────────────────────────────────────────────
// Devuelve lista de findos disponibles (para el selector de navegación)
router.get('/periods', auth, adminOnly, async (req, res) => {
  try {
    const view = req.query.view || 'finde';

    if (view === 'finde') {
      // Obtener findos desde primeros pedidos
      const oldest = await Order.findOne({ status: 'delivered' }).sort('createdAt');
      if (!oldest) return res.json([]);

      const periods = [];
      const now = new Date();
      let cur = getWeekId(oldest.createdAt);
      const limit = getWeekId(now);

      while (cur <= limit) {
        const fri = new Date(cur + 'T12:00:00');
        const sun = new Date(fri); sun.setDate(fri.getDate() + 2);
        periods.unshift({
          ref: cur,
          label: `${fri.toLocaleDateString('es-AR', { day: 'numeric', month: 'short' })} – ${sun.toLocaleDateString('es-AR', { day: 'numeric', month: 'short' })}`
        });
        // Avanzar al siguiente viernes
        const next = new Date(cur + 'T12:00:00');
        next.setDate(next.getDate() + 7);
        cur = next.toISOString().split('T')[0];
      }
      return res.json(periods);
    }

    res.json([]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

module.exports = router;
