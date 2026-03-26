const mongoose = require('mongoose');

// ── Fixture cacheado desde la API ─────────────────────────────────────────────
const matchSchema = new mongoose.Schema({
  apiId:       { type: String, required: true, unique: true },
  stage:       { type: String }, // 'Group Stage', 'Round of 16', 'Quarter-final', etc.
  group:       { type: String }, // 'Group A', 'Group B', null si es eliminatoria
  homeTeam:    { type: String, required: true },
  awayTeam:    { type: String, required: true },
  homeLogo:    { type: String },
  awayLogo:    { type: String },
  matchDate:   { type: Date, required: true },
  // Resultado final (null hasta que se juegue)
  homeScore:   { type: Number, default: null },
  awayScore:   { type: Number, default: null },
  status:      { type: String, enum: ['scheduled', 'live', 'finished'], default: 'scheduled' },
  // Ganador calculado: 'home' | 'away' | 'draw' | null
  winner:      { type: String, default: null },
}, { timestamps: true });

// ── Pronóstico de un cliente para un partido ──────────────────────────────────
const pronosticoSchema = new mongoose.Schema({
  clientId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Client', required: true },
  matchId:     { type: mongoose.Schema.Types.ObjectId, ref: 'ProdeMatch', required: true },
  // Pronóstico del resultado: 'home' | 'away' | 'draw'
  predictedWinner: { type: String, enum: ['home', 'away', 'draw'], required: true },
  // Resultado exacto (opcional, da puntos extra)
  predictedHome:   { type: Number, default: null },
  predictedAway:   { type: Number, default: null },
  // Puntos obtenidos (calculados al cerrar el partido)
  pointsEarned:    { type: Number, default: 0 },
  evaluated:       { type: Boolean, default: false },
}, { timestamps: true });

// Índice único: un cliente solo puede pronosticar una vez por partido
pronosticoSchema.index({ clientId: 1, matchId: 1 }, { unique: true });

// ── Historial de puntos del prode por cliente ─────────────────────────────────
const prodePointsSchema = new mongoose.Schema({
  clientId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Client', required: true },
  tipo:        { type: String, enum: ['pronostico', 'compra'], required: true },
  descripcion: { type: String },
  puntos:      { type: Number, required: true },
  // Referencia opcional al pedido (solo para tipo 'compra')
  orderId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null },
  // Referencia opcional al partido (solo para tipo 'pronostico')
  matchId:     { type: mongoose.Schema.Types.ObjectId, ref: 'ProdeMatch', default: null },
}, { timestamps: true });

// ── Configuración del prode (guardada en DB para editarla desde admin) ────────
const prodeConfigSchema = new mongoose.Schema({
  key:   { type: String, required: true, unique: true, default: 'prode' },
  value: {
    enabled:       { type: Boolean, default: false },
    startDate:     { type: Date, default: null },
    endDate:       { type: Date, default: null },
    pointsWinner:  { type: Number, default: 1 },
    pointsExact:   { type: Number, default: 5 },
    pointsPerOrder: { type: Number, default: 1 },
    cutoffMinutes: { type: Number, default: 30 },
    tournamentId:  { type: String, default: '132' },
    seasonId:      { type: String, default: '65360' },
    // ── Bonificaciones extra por condiciones de compra ──────────────────────
    bonificaciones: [{
      tipo: {
        type: String,
        enum: ['producto', 'gasto_minimo', 'por_cada_x'],
        // producto: comprar X producto = +N puntos
        // gasto_minimo: gastar más de $X = +N puntos
        // por_cada_x: cada $X gastado = +N puntos
      },
      descripcion:    { type: String },   // texto libre para mostrar en UI
      productoId:     { type: String },   // solo para tipo 'producto'
      productoNombre: { type: String },   // nombre legible
      montoMinimo:    { type: Number },   // para 'gasto_minimo' y 'por_cada_x'
      puntos:         { type: Number, default: 1 },
      activa:         { type: Boolean, default: true },
    }],
  }
}, { timestamps: true });

const ProdeMatch    = mongoose.model('ProdeMatch',    matchSchema);
const Pronostico    = mongoose.model('Pronostico',    pronosticoSchema);
const ProdePoints   = mongoose.model('ProdePoints',   prodePointsSchema);
const ProdeConfig   = mongoose.model('ProdeConfig',   prodeConfigSchema);

module.exports = { ProdeMatch, Pronostico, ProdePoints, ProdeConfig };
