const express  = require('express');
const router   = express.Router();
const Promo    = require('../models/Promo');
const { Product } = require('../models/Product');
const { auth, adminOnly } = require('../middleware/auth');

// ── Helpers ───────────────────────────────────────────────────────────────────

// Calcula el costo total de una promo sumando los costos ya calculados de sus componentes.
async function calcPromoCost(components) {
  let totalCost = 0;
  for (const c of components) {
    const product = await Product.findById(c.product).select('cost salePrice');
    if (product) totalCost += (product.cost || 0) * c.quantity;
  }
  return totalCost;
}

// Recalcula available según si todos los productos componentes están disponibles.
async function calcPromoAvailability(components) {
  for (const c of components) {
    const product = await Product.findById(c.product).select('available active');
    if (!product || !product.active || !product.available) return false;
  }
  return true;
}

// Popula los componentes con datos del producto para respuesta al cliente.
async function populateComponents(components) {
  const result = [];
  for (const c of components) {
    const product = await Product.findById(c.product).select('name variant salePrice cost image available active productType');
    result.push({ product, quantity: c.quantity });
  }
  return result;
}

// ── GET /api/promos — listar todas (admin) ────────────────────────────────────
router.get('/', auth, adminOnly, async (req, res) => {
  try {
    const promos = await Promo.find().sort({ createdAt: -1 });
    const result = await Promise.all(promos.map(async p => {
      const populated = await populateComponents(p.components);
      const cost = await calcPromoCost(p.components);
      const margin = p.salePrice > 0 ? Math.round(((p.salePrice - cost) / p.salePrice) * 100) : 0;
      return { ...p.toObject(), components: populated, cost, margin };
    }));
    res.json(result);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── POST /api/promos — crear promo ────────────────────────────────────────────
router.post('/', auth, adminOnly, async (req, res) => {
  try {
    const { name, description, components, salePrice, image } = req.body;
    if (!name?.trim())      return res.status(400).json({ message: 'El nombre es obligatorio' });
    if (!components?.length) return res.status(400).json({ message: 'Agregá al menos un producto' });
    if (!salePrice || salePrice <= 0) return res.status(400).json({ message: 'El precio de venta es obligatorio' });

    const available = await calcPromoAvailability(components);
    const promo = await Promo.create({ name: name.trim(), description: description?.trim() || '', components, salePrice, image: image || null, available });
    const populated = await populateComponents(promo.components);
    const cost   = await calcPromoCost(promo.components);
    const margin = promo.salePrice > 0 ? Math.round(((promo.salePrice - cost) / promo.salePrice) * 100) : 0;
    res.status(201).json({ ...promo.toObject(), components: populated, cost, margin });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── PUT /api/promos/:id — editar promo ────────────────────────────────────────
router.put('/:id', auth, adminOnly, async (req, res) => {
  try {
    const { name, description, components, salePrice, image, active } = req.body;
    const available = components ? await calcPromoAvailability(components) : undefined;
    const update = {};
    if (name        !== undefined) update.name        = name.trim();
    if (description !== undefined) update.description = description.trim();
    if (components  !== undefined) { update.components = components; update.available = available; }
    if (salePrice   !== undefined) update.salePrice   = salePrice;
    if (image       !== undefined) update.image       = image;
    if (active      !== undefined) update.active      = active;

    const promo = await Promo.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!promo) return res.status(404).json({ message: 'Promo no encontrada' });
    const populated = await populateComponents(promo.components);
    const cost   = await calcPromoCost(promo.components);
    const margin = promo.salePrice > 0 ? Math.round(((promo.salePrice - cost) / promo.salePrice) * 100) : 0;
    res.json({ ...promo.toObject(), components: populated, cost, margin });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── DELETE /api/promos/:id ────────────────────────────────────────────────────
router.delete('/:id', auth, adminOnly, async (req, res) => {
  try {
    await Promo.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── POST /api/promos/recalc-availability — actualizar available de todas ──────
// Se llama desde stock.service.js después de cada pedido (mismo patrón que productos).
router.post('/recalc-availability', auth, adminOnly, async (req, res) => {
  try {
    await autoUpdatePromoAvailability();
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

module.exports = router;
