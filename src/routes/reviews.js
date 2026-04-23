const express = require('express');
const router = express.Router();
const Review = require('../models/Review');
const { auth, adminOnly } = require('../middleware/auth');

// GET /api/reviews — lista con filtros
router.get('/', auth, adminOnly, async (req, res) => {
  try {
    const { stars, page = 1, limit = 20, unread, completed } = req.query;
    const filter = {};
    if (stars)  filter.stars = Number(stars);
    if (unread === 'true') filter.reviewed = false;
    if (completed === 'true')  filter.completed = true;
    if (completed === 'false') filter.completed = { $ne: true };

    const total   = await Review.countDocuments(filter);
    const reviews = await Review.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit))
      .populate('client', 'name whatsapp');

    // Stats generales (solo reseñas completadas por el cliente)
    const all = await Review.find({ completed: true });
    const avgStars = all.length > 0
      ? (all.reduce((s, r) => s + r.stars, 0) / all.length).toFixed(1)
      : 0;
    const dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    all.forEach(r => { dist[r.stars] = (dist[r.stars] || 0) + 1; });

    const burgerRatingCount = {};
    const tempRatingCount   = {};
    let onTimeYes = 0, onTimeNo = 0;

    // NPS: distribución de scores y promotores (score 4-5 = potencial referido)
    const npsDist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    let npsTotal = 0, npsSum = 0, npsPromoters = 0;

    all.forEach(r => {
      if (r.burgerRating) burgerRatingCount[r.burgerRating] = (burgerRatingCount[r.burgerRating] || 0) + 1;
      if (r.tempRating)   tempRatingCount[r.tempRating]     = (tempRatingCount[r.tempRating]     || 0) + 1;
      if (r.onTime === true)  onTimeYes++;
      if (r.onTime === false) onTimeNo++;
      if (r.npsScore != null) {
        npsDist[r.npsScore] = (npsDist[r.npsScore] || 0) + 1;
        npsSum += r.npsScore;
        npsTotal++;
        if (r.npsScore >= 4) npsPromoters++;
      }
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
        onTime: { yes: onTimeYes, no: onTimeNo },
        nps: {
          total: npsTotal,
          avg: npsTotal > 0 ? Number((npsSum / npsTotal).toFixed(1)) : 0,
          promoters: npsPromoters,
          distribution: npsDist
        }
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

// POST /api/reviews/:id/send-request — envío manual del WA de solicitud de reseña
router.post('/:id/send-request', auth, adminOnly, async (req, res) => {
  try {
    const review = await Review.findById(req.params.id);
    if (!review) return res.status(404).json({ message: 'Reseña no encontrada' });
    if (review.completed) return res.status(400).json({ message: 'El cliente ya completó la reseña' });
    if (!review.clientWhatsapp) return res.status(400).json({ message: 'El cliente no tiene número de WhatsApp' });

    const { sendReviewRequest } = require('../services/whatsapp');
    await sendReviewRequest(review.clientWhatsapp, review.clientName, review.publicCode);
    await Review.findByIdAndUpdate(review._id, { requestSent: true });
    res.json({ success: true, message: `WA enviado a ${review.clientName}` });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

module.exports = router;
