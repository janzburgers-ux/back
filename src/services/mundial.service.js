/**
 * mundial.service.js
 * Obtiene el próximo partido de Argentina desde openfootball/worldcup.json
 * (GitHub público, sin API key, actualizado automáticamente con resultados)
 *
 * Fuente: https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.json
 */

const axios = require('axios');

const FIXTURE_URL =
  'https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.json';

// Cache en memoria — se refresca cada 1 hora
let _cache     = null;
let _cacheTime = null;
const CACHE_TTL = 60 * 60 * 1000; // 1 hora

// ── Etiquetas de ronda ────────────────────────────────────────────────────────
const ROUND_LABELS = {
  'Matchday 1': 'Fase de Grupos',
  'Matchday 2': 'Fase de Grupos',
  'Matchday 3': 'Fase de Grupos',
  'Round of 32':      'Octava de Final',
  'Round of 16':      'Octavos de Final',
  'Quarterfinals':    'Cuartos de Final',
  'Semifinals':       'Semifinales',
  'Third Place':      'Tercer Puesto',
  'Final':            'Final',
};

/**
 * Convierte la fecha y hora del JSON a Date UTC.
 * El JSON usa strings como "2026-06-17" y "01:00 UTC" o "19:00 UTC-6"
 */
function parseMatchDate(dateStr, timeStr = '00:00 UTC') {
  try {
    const [timePart, tzPart = 'UTC'] = timeStr.trim().split(' ');
    const [hh, mm] = timePart.split(':').map(Number);

    let offsetHours = 0;
    if (tzPart !== 'UTC') {
      const m = tzPart.match(/UTC([+-]\d+)/);
      if (m) offsetHours = parseInt(m[1], 10);
    }

    const [yr, mo, dy] = dateStr.split('-').map(Number);
    // Convertimos a UTC restando el offset (UTC-6 → sumar 6h)
    return new Date(Date.UTC(yr, mo - 1, dy, hh - offsetHours, mm));
  } catch {
    return new Date(dateStr);
  }
}

/**
 * Determina si Argentina jugó el partido (tiene score) o está pendiente.
 */
function matchStatus(match) {
  if (match.score && match.score.ft) return 'played';
  return 'upcoming';
}

/**
 * Descarga el fixture completo con cache de 1 hora.
 */
async function fetchFixture() {
  if (_cache && _cacheTime && Date.now() - _cacheTime < CACHE_TTL) {
    return _cache;
  }
  const { data } = await axios.get(FIXTURE_URL, { timeout: 8000 });
  _cache     = data;
  _cacheTime = Date.now();
  return data;
}

/**
 * Devuelve el próximo partido de Argentina (el más cercano que no haya sido jugado),
 * o null si no se encuentra.
 *
 * Retorna:
 * {
 *   opponent: string,
 *   date:     ISO string (UTC),
 *   label:    string (etapa del partido),
 *   stadium:  string,
 *   isHome:   boolean,
 * }
 */
async function getNextArgentinaMatch() {
  const data    = await fetchFixture();
  const matches = data.matches || [];
  const now     = new Date();

  const argMatches = matches
    .filter(m => {
      const t1 = (m.team1 || '').toLowerCase();
      const t2 = (m.team2 || '').toLowerCase();
      return t1 === 'argentina' || t2 === 'argentina';
    })
    .map(m => {
      const matchDate = parseMatchDate(m.date, m.time);
      const isHome    = (m.team1 || '').toLowerCase() === 'argentina';
      const opponent  = isHome ? m.team2 : m.team1;
      const status    = matchStatus(m);
      const label     = ROUND_LABELS[m.round] || m.round || 'Mundial 2026';

      return { opponent, date: matchDate.toISOString(), label, stadium: m.ground || '', isHome, status, _rawDate: matchDate };
    })
    .sort((a, b) => a._rawDate - b._rawDate);

  // Partido más próximo que todavía no fue jugado
  // (o que empezó hace menos de 2 horas — puede estar en curso)
  const upcoming = argMatches.find(m =>
    m.status === 'upcoming' && m._rawDate > new Date(now - 2 * 60 * 60 * 1000)
  );

  if (!upcoming) return null;

  return {
    opponent: upcoming.opponent,
    date:     upcoming.date,
    label:    upcoming.label,
    stadium:  upcoming.stadium,
    isHome:   upcoming.isHome,
  };
}

/**
 * Devuelve todos los partidos de Argentina (jugados + próximos).
 */
async function getAllArgentinaMatches() {
  const data    = await fetchFixture();
  const matches = data.matches || [];

  return matches
    .filter(m => {
      const t1 = (m.team1 || '').toLowerCase();
      const t2 = (m.team2 || '').toLowerCase();
      return t1 === 'argentina' || t2 === 'argentina';
    })
    .map(m => {
      const matchDate = parseMatchDate(m.date, m.time);
      const isHome    = (m.team1 || '').toLowerCase() === 'argentina';
      const opponent  = isHome ? m.team2 : m.team1;
      return {
        opponent, stadium: m.ground || '',
        date:   matchDate.toISOString(),
        label:  ROUND_LABELS[m.round] || m.round || 'Mundial 2026',
        isHome,
        status: matchStatus(m),
        score:  m.score?.ft ? { arg: isHome ? m.score.ft[0] : m.score.ft[1], opp: isHome ? m.score.ft[1] : m.score.ft[0] } : null,
      };
    })
    .sort((a, b) => new Date(a.date) - new Date(b.date));
}

module.exports = { getNextArgentinaMatch, getAllArgentinaMatches };
