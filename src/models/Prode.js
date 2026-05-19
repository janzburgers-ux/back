const mongoose = require('mongoose');

// ── ProdeMatch — un partido del fixture ───────────────────────────────────────
const ProdeMatchSchema = new mongoose.Schema({
  matchId:    { type: Number, unique: true }, // ID de API-Football
  homeTeam:   { type: String, required: true },
  awayTeam:   { type: String, required: true },
  homeLogo:   { type: String, default: '' },
  awayLogo:   { type: String, default: '' },
  matchDate:  { type: Date, required: true },
  stage:      { type: String, default: 'Fase de Grupos' }, // Fase de Grupos, Octavos, etc.
  group:      { type: String, default: '' },               // Grupo A, B, etc.
  status:     { type: String, enum: ['scheduled', 'live', 'finished'], default: 'scheduled' },
  homeScore:  { type: Number, default: null },
  awayScore:  { type: Number, default: null },
  winner:     { type: String, enum: ['home', 'away', 'draw', null], default: null },
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
  clientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Client', required: true },
  matchId:  { type: mongoose.Schema.Types.ObjectId, ref: 'ProdeMatch', default: null },
  puntos:   { type: Number, required: true },
  motivo:   { type: String, default: '' }, // 'pronostico', 'bonificacion', etc.
}, { timestamps: true });

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