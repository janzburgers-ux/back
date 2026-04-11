/**
 * arDate.js — Utilidades de timezone Argentina (UTC-3)
 *
 * El servidor corre en UTC (Railway). Argentina es UTC-3.
 * A las 21:00hs AR → 00:00hs UTC del día siguiente → new Date() dice "mañana".
 * Todas las queries de fecha DEBEN usar estas helpers para evitar el bug.
 */

/** Fecha/hora actual en timezone Argentina */
function nowAR() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
}

/** Rango de un día (YYYY-MM-DD) en timezone Argentina */
function dayRangeAR(dateStr) {
  return {
    start: new Date(dateStr + 'T00:00:00-03:00'),
    end:   new Date(dateStr + 'T23:59:59.999-03:00')
  };
}

/** Rango del día actual Argentina */
function todayRangeAR() {
  const ar = nowAR();
  const dateStr = arDateStr(ar);
  return dayRangeAR(dateStr);
}

/** Rango de la semana actual (lunes a hoy) en AR — para dashboard */
function thisWeekRangeAR() {
  const ar = nowAR();
  const day = ar.getDay(); // 0=dom, 1=lun...
  const monday = new Date(ar);
  monday.setDate(ar.getDate() - ((day + 6) % 7));
  const mondayStr = arDateStr(monday);
  const todayStr  = arDateStr(ar);
  return {
    start: new Date(mondayStr + 'T00:00:00-03:00'),
    end:   new Date(todayStr  + 'T23:59:59.999-03:00')
  };
}

/** Rango del mes actual en AR */
function thisMonthRangeAR() {
  const ar = nowAR();
  const y = ar.getFullYear();
  const m = ar.getMonth() + 1;
  return monthRangeAR(y, m);
}

/** Rango del mes anterior en AR */
function prevMonthRangeAR() {
  const ar = nowAR();
  let y = ar.getFullYear();
  let m = ar.getMonth(); // 0-indexed → mes anterior
  if (m === 0) { m = 12; y--; }
  return monthRangeAR(y, m);
}

/** Rango de un mes dado (year, month 1-12) en AR */
function monthRangeAR(year, month) {
  const y = Number(year);
  const m = Number(month);
  const lastDay = new Date(y, m, 0).getDate();
  const pad = n => String(n).padStart(2, '0');
  return {
    start: new Date(`${y}-${pad(m)}-01T00:00:00-03:00`),
    end:   new Date(`${y}-${pad(m)}-${pad(lastDay)}T23:59:59.999-03:00`)
  };
}

/** Rango de un año en AR */
function yearRangeAR(year) {
  const y = Number(year);
  return {
    start: new Date(`${y}-01-01T00:00:00-03:00`),
    end:   new Date(`${y}-12-31T23:59:59.999-03:00`)
  };
}

/** Convierte una fecha JS a string YYYY-MM-DD en timezone Argentina */
function arDateStr(date) {
  const ar = new Date(date.toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
  const y = ar.getFullYear();
  const m = String(ar.getMonth() + 1).padStart(2, '0');
  const d = String(ar.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Obtiene el día de la semana en AR (0=dom, 1=lun... 5=vie, 6=sab) */
function arDayOfWeek() {
  return nowAR().getDay();
}

/** Obtiene la hora actual en AR como string HH:MM */
function arTimeStr() {
  const ar = nowAR();
  return `${String(ar.getHours()).padStart(2, '0')}:${String(ar.getMinutes()).padStart(2, '0')}`;
}

/** Obtiene la hora (0-23) en AR — para estadísticas por hora */
function arHour(date) {
  const ar = new Date(date.toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
  return ar.getHours();
}

/** Obtiene el día del mes en AR — para gráficos por día */
function arDayOfMonth(date) {
  const ar = new Date(date.toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
  return ar.getDate();
}

module.exports = {
  nowAR,
  dayRangeAR,
  todayRangeAR,
  thisWeekRangeAR,
  thisMonthRangeAR,
  prevMonthRangeAR,
  monthRangeAR,
  yearRangeAR,
  arDateStr,
  arDayOfWeek,
  arTimeStr,
  arHour,
  arDayOfMonth
};
