const mongoose = require('mongoose');

// ── Cajitas de distribución ───────────────────────────────────────────────────
const bucketSchema = new mongoose.Schema({
  key:         { type: String, required: true },  // ej: 'produccion', 'gastos_fijos'
  label:       { type: String, required: true },  // ej: 'Producción'
  emoji:       { type: String, default: '💰' },
  percent:     { type: Number, required: true, min: 0, max: 100 },
  active:      { type: Boolean, default: true },
  order:       { type: Number, default: 0 },
  description: { type: String, default: '' },
}, { _id: false });

// ── Registro de distribución por noche ───────────────────────────────────────
const nightRecordSchema = new mongoose.Schema({
  date:          { type: Date, required: true },
  totalRevenue:  { type: Number, required: true },  // ingresos brutos de la noche
  ayudante:      { type: Number, default: 0 },       // costo ayudante esa noche
  distribution:  [{                                  // cómo se distribuyó cada peso
    key:     { type: String },
    label:   { type: String },
    emoji:   { type: String },
    percent: { type: Number },
    amount:  { type: Number },
  }],
  notes: { type: String, default: '' },
}, { timestamps: true });

// ── Modelo principal de configuración de finanzas ────────────────────────────
const financeConfigSchema = new mongoose.Schema({
  buckets:          { type: [bucketSchema], default: [] },
  // Fondo de emergencia acumulado
  emergencyFund:    { type: Number, default: 0 },
  // Historial de noches
  nightRecords:     { type: [nightRecordSchema], default: [] },
}, { timestamps: true });

module.exports = mongoose.model('Finance', financeConfigSchema);
