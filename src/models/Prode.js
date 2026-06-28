const mongoose = require('mongoose');

// ── ProdeMatch — un partido del fixture ───────────────────────────────────────
const ProdeMatchSchema = new mongoose.Schema({
  apiId:          { type: String, unique: true, sparse: true },
  homeTeam:       { type: String, required: true },
  awayTeam:       { type: String, required: true },
  homeLogo:       { type: String, default: '' },
  awayLogo:       { type: String, default: '' },
  matchDate:      { type: Date, required: true },
  stage:          { type: String, default: 'Fase de Grupos' },
  group:          { type: String, default: '' },
  status:         { type: String, enum: ['scheduled', 'live', 'finished'], default: 'scheduled' },
  homeScore:      { type: Number, default: null },  // resultado de los 90' (base para pronósticos)
  awayScore:      { type: Number, default: null },  // resultado de los 90' (base para pronósticos)
  winner:         { type: String, enum: ['home', 'away', 'draw', null], default: null }, // basado en 90'
  // Campos adicionales para eliminación directa — solo informativo, no afectan puntuación
  extraTimeHome:  { type: Number, default: null },  // goles en alargue (home)
  extraTimeAway:  { type: Number, default: null },  // goles en alargue (away)
  penaltiesHome:  { type: Number, default: null },  // penales (home)
  penaltiesAway:  { type: Number, default: null },  // penales (away)
  wentToET:       { type: Boolean, default: false }, // true si hubo alargue
  wentToPens:     { type: Boolean, default: false }, // true si hubo penales
  qualifiedTeam:  { type: String, default: null },   // quién clasificó (puede diferir del winner de 90')
  // true = ambos equipos definidos; false = alguno es TBD (no se permiten pronósticos)
  teamsConfirmed: { type: Boolean, default: true },
}, { timestamps: true });

// ── Pronostico — pronóstico de un cliente para un partido ─────────────────────
const PronosticoSchema = new mongoose.Schema({
  clientId:        { type: mongoose.Schema.Types.ObjectId, ref: 'Client', required: true },
  matchId:         { type: mongoose.Schema.Types.ObjectId, ref: 'ProdeMatch', required: true },
  predictedWinner: { type: String, enum: ['home', 'away', 'draw'], required: true },
  predictedHome:   { type: Number, default: null },
  predictedAway:   { type: Number, default: null },
  evaluated:       { type: Boolean, default: false },
  pointsEarned:    { type: Number, default: 0 },
}, { timestamps: true });

PronosticoSchema.index({ clientId: 1, matchId: 1 }, { unique: true });

// ── ProdePoints — historial de puntos de un cliente ───────────────────────────
const ProdePointsSchema = new mongoose.Schema({
  clientId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Client', required: true },
  matchId:     { type: mongoose.Schema.Types.ObjectId, ref: 'ProdeMatch', default: null },
  orderId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null },
  puntos:      { type: Number, required: true },
  tipo:        { type: String, enum: ['pronostico', 'compra', 'bonificacion'], default: 'bonificacion' },
  subtipo:     { type: String, default: '' },
  descripcion: { type: String, default: '' },
}, { timestamps: true });

ProdePointsSchema.index({ clientId: 1 });
ProdePointsSchema.index(
  { clientId: 1, subtipo: 1 },
  { unique: true, partialFilterExpression: { subtipo: { $type: 'string', $ne: '' } } }
);

// ── ProdeConfig — configuración general del prode ─────────────────────────────
const ProdeConfigSchema = new mongoose.Schema({
  key:   { type: String, unique: true, required: true }, // siempre 'prode'
  value: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: true });

const ProdeMatch  = mongoose.model('ProdeMatch',  ProdeMatchSchema);
const Pronostico  = mongoose.model('Pronostico',  PronosticoSchema);
const ProdePoints = mongoose.model('ProdePoints', ProdePointsSchema);
const ProdeConfig = mongoose.model('ProdeConfig', ProdeConfigSchema);

module.exports = { ProdeMatch, Pronostico, ProdePoints, ProdeConfig };