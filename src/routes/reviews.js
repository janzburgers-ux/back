const express = require('express');
const router = express.Router();
const Review = require('../models/Review');
const { auth, adminOnly } = require('../middleware/auth');

// GET /api/reviews — lista con filtros
router.get('/', auth, adminOnly, async (req, res) => {
  try {
    const { stars, page = 1, limit = 20, unread } = req.query;
    const filter = {};
    if (stars)  filter.stars = Number(stars);
    if (unread === 'true') filter.reviewed = false;

    const total   = await Review.countDocuments(filter);
    const reviews = await Review.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit))
      .populate('client', 'name whatsapp');

    // Stats generales
    const all = await Review.find({});
    const avgStars = all.length > 0
      ? (all.reduce((s, r) => s + r.stars, 0) / all.length).toFixed(1)
      : 0;
    const dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    all.forEach(r => { dist[r.stars] = (dist[r.stars] || 0) + 1; });

    const burgerRatingCount = {};
    const tempRatingCount   = {};
    let onTimeYes = 0, onTimeNo = 0;
    all.forEach(r => {
      if (r.burgerRating) burgerRatingCount[r.burgerRating] = (burgerRatingCount[r.burgerRating] || 0) + 1;
      if (r.tempRating)   tempRatingCount[r.tempRating]     = (tempRatingCount[r.tempRating]     || 0) + 1;
      if (r.onTime === true)  onTimeYes++;
      if (r.onTime === false) onTimeNo++;
    });

    res.json({
      reviews,
      total,
      pages: Math.ceil(total / limit),
      stats: {
        avgStars: Number(avgStars),
        total: all.length,
        unread: all.filter(r => !r.reviewed).length,
        distribution: dist,
        burgerRating: burgerRatingCount,
        tempRating: tempRatingCount,
        onTime: { yes: onTimeYes, no: onTimeNo }
      }
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// PUT /api/reviews/:id/read — marcar como revisada
router.put('/:id/read', auth, adminOnly, async (req, res) => {
  try {
    const review = await Review.findByIdAndUpdate(req.params.id, { reviewed: true }, { new: true });
    if (!review) return res.status(404).json({ message: 'Reseña no encontrada' });
    res.json(review);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// DELETE /api/reviews/:id
router.delete('/:id', auth, adminOnly, async (req, res) => {
  try {
    await Review.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

module.exports = router;
