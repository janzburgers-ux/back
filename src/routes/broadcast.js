const express = require('express');
const router = express.Router();
const { Client } = require('../models/Order');
const { auth, adminOnly } = require('../middleware/auth');

// ── Helpers ───────────────────────────────────────────────────────────────────
function encodeToken(clientId) {
  return Buffer.from(clientId.toString()).toString('base64url');
}

function decodeToken(token) {
  try {
    return Buffer.from(token, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

function buildUnsubUrl(req, clientId) {
  const base = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  return `${base}/api/broadcast/unsub/${encodeToken(clientId)}`;
}

// ── GET /api/broadcast/list — clientes que recibirían el broadcast ─────────────
router.get('/list', auth, adminOnly, async (req, res) => {
  try {
    const clients = await Client.find({
      totalOrders: { $gte: 1 },
      broadcastOptOut: { $ne: true },
      active: true,
      whatsapp: { $exists: true, $ne: '' }
    }).select('name nickname whatsapp totalOrders').sort('-totalOrders');

    res.json({ count: clients.length, clients });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── POST /api/broadcast/send — enviar mensaje masivo ──────────────────────────
// Body: { message: string, testMode?: boolean, testPhone?: string }
// Si testMode=true, solo se envía al testPhone ignorando la lista real.
router.post('/send', auth, adminOnly, async (req, res) => {
  try {
    const { message, testMode, testPhone } = req.body;
    if (!message?.trim()) {
      return res.status(400).json({ message: 'El mensaje no puede estar vacío' });
    }

    const { sendMessage } = require('../services/whatsapp');

    // ── MODO PRUEBA ───────────────────────────────────────────────────────────
    if (testMode) {
      if (!testPhone?.trim()) {
        return res.status(400).json({ message: 'En modo prueba necesitás ingresar un número de WhatsApp' });
      }
      const footer = `\n\n_[PRUEBA] Si no deseás recibir más estos mensajes, cancelá la suscripción._`;
      const fullMsg = `🧪 *MENSAJE DE PRUEBA*\n\n` + message.trim() + footer;
      const result = await sendMessage(testPhone.trim(), fullMsg);
      console.log(`[Broadcast-TEST] Enviado a ${testPhone}: ${result?.success ? 'OK' : result?.reason}`);
      return res.json({
        success: true,
        testMode: true,
        sent: result?.success ? 1 : 0,
        failed: result?.success ? 0 : 1,
        results: [{
          name: 'Prueba',
          whatsapp: testPhone,
          status: result?.success ? 'enviado' : 'error',
          reason: result?.reason || result?.error || null
        }]
      });
    }

    // ── ENVÍO REAL ────────────────────────────────────────────────────────────
    const clients = await Client.find({
      totalOrders: { $gte: 1 },
      broadcastOptOut: { $ne: true },
      active: true,
      whatsapp: { $exists: true, $ne: '' }
    }).select('name nickname whatsapp _id');

    if (!clients.length) {
      return res.json({ success: true, sent: 0, failed: 0, results: [] });
    }

    const results = [];

    for (const client of clients) {
      try {
        const unsubUrl = buildUnsubUrl(req, client._id);
        const footer = `\n\n_Si no deseás recibir más estos mensajes, ingresá a: ${unsubUrl}_`;
        const fullMsg = message.trim() + footer;

        const result = await sendMessage(client.whatsapp, fullMsg);

        results.push({
          name: client.name,
          whatsapp: client.whatsapp,
          status: result?.success ? 'enviado' : 'error',
          reason: result?.reason || result?.error || null
        });
      } catch (e) {
        results.push({ name: client.name, whatsapp: client.whatsapp, status: 'error', reason: e.message });
      }

      // Pausa entre mensajes para no saturar WhatsApp
      await new Promise(r => setTimeout(r, 1000));
    }

    const sent   = results.filter(r => r.status === 'enviado').length;
    const failed = results.filter(r => r.status !== 'enviado').length;

    console.log(`[Broadcast] Enviado: ${sent} | Fallido: ${failed} | Total: ${clients.length}`);
    res.json({ success: true, sent, failed, results });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── GET /api/broadcast/unsub/:token — desuscripción pública sin auth ──────────
router.get('/unsub/:token', async (req, res) => {
  try {
    const clientId = decodeToken(req.params.token);
    if (!clientId) {
      return res.status(400).send('<h2>Link inválido</h2>');
    }

    const client = await Client.findById(clientId);
    if (!client) {
      return res.status(404).send('<h2>Cliente no encontrado</h2>');
    }

    if (client.broadcastOptOut) {
      return res.send(`
        <html><body style="font-family:sans-serif;text-align:center;padding:40px">
          <h2>Ya estabas dado de baja</h2>
          <p>${client.name}, ya no recibís mensajes de difusión de Janz Burgers.</p>
        </body></html>
      `);
    }

    await Client.findByIdAndUpdate(clientId, { $set: { broadcastOptOut: true } });

    console.log(`[Broadcast] Unsub: ${client.name} (${client.whatsapp})`);

    res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:40px">
        <h2>¡Listo! Te dimos de baja 👍</h2>
        <p>${client.name}, ya no vas a recibir más mensajes de difusión de Janz Burgers.</p>
        <p style="color:#888;font-size:14px">Podés seguir haciendo pedidos normalmente en la app.</p>
      </body></html>
    `);
  } catch (err) {
    res.status(500).send('<h2>Ocurrió un error. Intentá más tarde.</h2>');
  }
});

module.exports = router;
