// Model
const mongoose = require('mongoose');
const expenseSchema = new mongoose.Schema({
  description: { type: String, required: true },
  amount:      { type: Number, required: true },
  category:    { type: String, default: 'Otro' },
  date:        { type: String, required: true }, // YYYY-MM-DD
  notes:       { type: String, default: '' }
}, { timestamps: true });
const Expense = mongoose.model('Expense', expenseSchema);

const express = require('express');
const router = express.Router();
const { auth, adminOnly } = require('../middleware/auth');

router.get('/', auth, adminOnly, async (req, res) => {
  try {
    const { month } = req.query;
    const filter = month ? { date: { $regex: `^${month}` } } : {};
    const expenses = await Expense.find(filter).sort('-date -createdAt');
    res.json(expenses);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.post('/', auth, adminOnly, async (req, res) => {
  try {
    const expense = new Expense(req.body);
    await expense.save();
    res.status(201).json(expense);
  } catch (err) { res.status(400).json({ message: err.message }); }
});

router.delete('/:id', auth, adminOnly, async (req, res) => {
  try {
    await Expense.findByIdAndDelete(req.params.id);
    res.json({ message: 'Eliminado' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// GET monthly total (for dashboard integration)
router.get('/monthly-total', auth, adminOnly, async (req, res) => {
  try {
    const { month } = req.query;
    const m = month || new Date().toISOString().slice(0, 7);
    const result = await Expense.aggregate([
      { $match: { date: { $regex: `^${m}` } } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);
    res.json({ total: result[0]?.total || 0, month: m });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

module.exports = router;
