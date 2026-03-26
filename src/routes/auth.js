const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { auth, adminOnly } = require('../middleware/auth');

// Login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email, active: true });
    if (!user || !(await user.comparePassword(password))) {
      return res.status(401).json({ message: 'Credenciales inválidas' });
    }
    const token = jwt.sign(
      { id: user._id, role: user.role },
      process.env.JWT_SECRET || 'janz_secret',
      { expiresIn: process.env.JWT_EXPIRE || '7d' }
    );
    res.json({
      token,
      user: { id: user._id, name: user.name, email: user.email, role: user.role }
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Get current user
router.get('/me', auth, (req, res) => {
  res.json(req.user);
});

// Change password
router.put('/password', auth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const user = await User.findById(req.user._id);
    if (!(await user.comparePassword(currentPassword))) {
      return res.status(400).json({ message: 'Contraseña actual incorrecta' });
    }
    user.password = newPassword;
    await user.save();
    res.json({ message: 'Contraseña actualizada' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Get all users (admin only)
router.get('/users', auth, adminOnly, async (req, res) => {
  try {
    const users = await User.find({ active: true }).select('-password').sort('name');
    res.json(users);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Create user (admin only)
router.post('/users', auth, adminOnly, async (req, res) => {
  try {
    const existing = await User.findOne({ email: req.body.email });
    if (existing) return res.status(400).json({ message: 'Ya existe un usuario con ese email' });
    const user = new User(req.body);
    await user.save();
    const { password, ...userData } = user.toObject();
    res.status(201).json(userData);
  } catch (err) { res.status(400).json({ message: err.message }); }
});

// Update user — nombre, rol y % de ganancias (admin only)
router.put('/users/:id', auth, adminOnly, async (req, res) => {
  try {
    const { name, role, profitShare } = req.body;
    const fields = {};
    if (name !== undefined)         fields.name = name;
    if (role !== undefined)         fields.role = role;
    if (profitShare !== undefined)  fields.profitShare = Number(profitShare);

    const updated = await User.findByIdAndUpdate(
      req.params.id,
      { $set: fields },
      { new: true }
    ).select('-password');

    if (!updated) return res.status(404).json({ message: 'Usuario no encontrado' });
    res.json(updated);
  } catch (err) { res.status(400).json({ message: err.message }); }
});

// Delete user — soft delete (admin only)
router.delete('/users/:id', auth, adminOnly, async (req, res) => {
  try {
    if (req.params.id === req.user._id.toString()) {
      return res.status(400).json({ message: 'No podés eliminarte a vos mismo' });
    }
    await User.findByIdAndUpdate(req.params.id, { active: false });
    res.json({ message: 'Usuario eliminado' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

module.exports = router;