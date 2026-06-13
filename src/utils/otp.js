// ── OTP en memoria con TTL ──────────────────────────────────────────────────
// Funciona perfectamente para el volumen de Janz.
// Se pierde en restart (aceptable — el usuario simplemente pide un código nuevo).

const store = new Map(); // key = últimos 8 dígitos del WA, value = { code, clientId, createdAt, expiresAt, attempts }

function generateCode() {
  return String(Math.floor(1000 + Math.random() * 9000)); // 4 dígitos: 1000–9999
}

// Limpieza periódica para no acumular entradas viejas
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store.entries()) {
    if (now > entry.expiresAt) store.delete(key);
  }
}, 5 * 60 * 1000);


// ── Solicitar un código ──────────────────────────────────────────────────────
// Retorna { ok: true, code } o { ok: false, reason, resendAt? }
function requestOTP(key, clientId) {
  const now = Date.now();
  const existing = store.get(key);

  // Rate limit: no más de 1 código cada 60 segundos
  if (existing && (now - existing.createdAt) < 60_000) {
    return { ok: false, reason: 'rate_limit', resendAt: existing.createdAt + 60_000 };
  }

  const code = generateCode();
  store.set(key, {
    code,
    clientId,
    createdAt: now,
    expiresAt: now + 5 * 60_000, // 5 minutos
    attempts: 0,
  });

  return { ok: true, code };
}

// ── Verificar un código ──────────────────────────────────────────────────────
// Retorna { ok: true, clientId } o { ok: false, reason }
function verifyOTP(key, inputCode) {
  const entry = store.get(key);

  if (!entry) return { ok: false, reason: 'not_found' };

  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return { ok: false, reason: 'expired' };
  }

  entry.attempts += 1;

  if (entry.attempts > 5) {
    store.delete(key);
    return { ok: false, reason: 'too_many' };
  }

  if (String(inputCode).trim() !== entry.code) {
    return { ok: false, reason: 'invalid', attemptsLeft: 5 - entry.attempts };
  }

  store.delete(key);
  return { ok: true, clientId: entry.clientId };
}

module.exports = { requestOTP, verifyOTP };
