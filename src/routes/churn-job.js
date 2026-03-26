const express = require('express');
const router = express.Router();
const Config = require('../models/Config');
const { auth, adminOnly } = require('../middleware/auth');
const { runChurnAlertJob, getChurnConfig, startChurnJob } = require('../jobs/churn-alert');

// GET config actual
router.get('/config', auth, adminOnly, async (req, res) => {
  try {
    const config = await getChurnConfig();
    const lastRun = await Config.findOne({ key: 'churnAlertLastRun' });
    res.json({ config, lastRun: lastRun?.value || null });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// PUT actualizar config
router.put('/config', auth, adminOnly, async (req, res) => {
  try {
    const newConfig = req.body;
    await Config.findOneAndUpdate(
      { key: 'churnAlert' },
      { $set: { key: 'churnAlert', value: newConfig, label: 'Configuración alertas de churn' } },
      { upsert: true, new: true }
    );
    // Reiniciar cron con nuevo schedule
    await startChurnJob();
    res.json({ message: 'Config actualizada', config: newConfig });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// POST disparar manualmente
router.post('/run', auth, adminOnly, async (req, res) => {
  try {
    const result = await runChurnAlertJob(true);
    res.json(result);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

module.exports = router;
