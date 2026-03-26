const jwt = require('jsonwebtoken');
const User = require('../models/User');

const auth = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ message: 'No autorizado' });

    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'janz_secret');
    req.user = await User.findById(decoded.id).select('-password');
    if (!req.user) return res.status(401).json({ message: 'Usuario no encontrado' });
    next();
  } catch (err) {
    res.status(401).json({ message: 'Token inválido' });
  }
};

const adminOnly = (req, res, next) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Solo administradores' });
  }
  next();
};

const kitchenOrAdmin = (req, res, next) => {
  if (!['admin', 'kitchen'].includes(req.user.role)) {
    return res.status(403).json({ message: 'Acceso no permitido' });
  }
  next();
};

module.exports = { auth, adminOnly, kitchenOrAdmin };
