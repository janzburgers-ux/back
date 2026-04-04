const express = require('express');
const router = express.Router();
const webpush = require('web-push');
const { auth, adminOnly } = require('../middleware/auth');
const PushSubscription = require('../models/PushModels');
const { PushNotification } = require('../models/PushModels');

// Configurar VAPID keys (deben estar en .env)
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    'mailto:' + (process.env.VAPID_EMAIL || 'admin@janzburgers.com'),
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

// POST /api/push/subscribe — el cliente se suscribe
router.post('/subscribe', async (req, res) => {
  try {
    const { subscription, userAgent } = req.body;
    if (!subscription?.endpoint) return res.status(400).json({ message: 'Suscripción inválida' });

    await PushSubscription.findOneAndUpdate(
      { endpoint: subscription.endpoint },
      { subscription, userAgent: userAgent || '', active: true, updatedAt: new Date() },
      { upsert: true, new: true }
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// DELETE /api/push/unsubscribe — el cliente se desuscribe
router.delete('/unsubscribe', async (req, res) => {
  try {
    const { endpoint } = req.body;
    await PushSubscription.findOneAndUpdate({ endpoint }, { active: false });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/push/subscribers/count — cantidad de suscriptores activos
router.get('/subscribers/count', auth, adminOnly, async (req, res) => {
  try {
    const count = await PushSubscription.countDocuments({ active: true });
    res.json({ count });
  } catch (err) {
    res.status(500).json({ count: 0 });
  }
});

// GET /api/push/notifications — historial de notificaciones enviadas
router.get('/notifications', auth, adminOnly, async (req, res) => {
  try {
    const notifications = await PushNotification.find().sort({ createdAt: -1 }).limit(50);
    res.json(notifications);
  } catch (err) {
    res.status(500).json([]);
  }
});

// POST /api/push/send — enviar notificación push a todos los suscriptores
router.post('/send', auth, adminOnly, async (req, res) => {
  try {
    const { title, body, icon, scheduledAt } = req.body;
    if (!title || !body) return res.status(400).json({ message: 'Título y mensaje son requeridos' });

    if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
      return res.status(503).json({ message: 'VAPID keys no configuradas en el servidor' });
    }

    // Guardar la notificación en DB
    const notification = await PushNotification.create({
      title, body, icon: icon || '🍔',
      scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
      sent: !scheduledAt, // si no tiene scheduledAt, se envía ahora
      sentAt: !scheduledAt ? new Date() : null,
      delivered: 0,
    });

    // Si es programada, se envía por el job scheduler (no implementado aquí)
    if (scheduledAt) {
      return res.json({ success: true, scheduled: true, notification });
    }

    // Enviar a todos los suscriptores activos
    const subscribers = await PushSubscription.find({ active: true });
    let delivered = 0;
    const failed = [];

    const payload = JSON.stringify({ title, body, icon: icon || '🍔', url: '/pedido' });

    await Promise.allSettled(
      subscribers.map(async (sub) => {
        try {
          await webpush.sendNotification(sub.subscription, payload);
          delivered++;
        } catch (err) {
          // Si el endpoint ya no existe, desactivar la suscripción
          if (err.statusCode === 410 || err.statusCode === 404) {
            await PushSubscription.findByIdAndUpdate(sub._id, { active: false });
          }
          failed.push(sub.endpoint);
        }
      })
    );

    // Actualizar conteo de entregadas
    await PushNotification.findByIdAndUpdate(notification._id, { delivered, sentAt: new Date() });

    res.json({ success: true, delivered, failed: failed.length });
  } catch (err) {
    console.error('Push send error:', err);
    res.status(500).json({ message: err.message });
  }
});

// DELETE /api/push/notifications/:id — eliminar del historial
router.delete('/notifications/:id', auth, adminOnly, async (req, res) => {
  try {
    await PushNotification.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;