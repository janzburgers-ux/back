/**
 * prode-pdf.service.js
 * Genera un PDF con los pronósticos de un cliente usando puppeteer.
 * Puppeteer ya está disponible como dependencia transitiva de whatsapp-web.js.
 */

const { Pronostico }        = require('../models/Prode');
const { resolveProdeStatus, getProdeConfig } = require('./prode.service');

// ── Helpers ────────────────────────────────────────────────────────────────────
function fmtDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('es-AR', {
    weekday: 'short', day: '2-digit', month: 'short',
    timeZone: 'America/Argentina/Buenos_Aires',
  });
}

function fmtTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString('es-AR', {
    hour: '2-digit', minute: '2-digit',
    timeZone: 'America/Argentina/Buenos_Aires',
  });
}

function initials(name = '') {
  return name.trim().split(/\s+/).map(w => w[0] || '').join('').slice(0, 2).toUpperCase();
}

// ── Construir HTML del PDF ────────────────────────────────────────────────────
function buildProdeHTML(status, pronosticos, cfg) {
  const nombre     = status.nombre || 'Participante';
  const totalPts   = status.totalPuntos || 0;
  const catLabel   = status.categoriaLabel || 'Invitado';
  const premio     = status.premioDescripcion || '';
  const proximoPaso = status.proximoPaso || '';

  // Badge color por categoría
  const catColor =
    status.categoria === 'vip'     ? '#E8B84B' :
    status.categoria === 'cliente' ? '#60a5fa' : '#9ca3af';

  // Agrupar pronósticos por etapa
  const byStage = {};
  for (const p of pronosticos) {
    const stage = p.matchId?.stage || 'General';
    if (!byStage[stage]) byStage[stage] = [];
    byStage[stage].push(p);
  }

  // ── Tarjeta de cada pronóstico ─────────────────────────────────────────────
  function matchCard(p) {
    const m      = p.matchId || {};
    const hs     = m.homeScore ?? null;
    const as     = m.awayScore ?? null;
    const isPend = m.status !== 'finished';
    const predH  = p.predictedHome ?? '-';
    const predA  = p.predictedAway ?? '-';

    const ganadorLabel = {
      home: m.homeTeam, away: m.awayTeam, draw: 'Empate'
    }[p.predictedWinner] || '?';

    const homeLogo = m.homeLogo
      ? `<img src="${m.homeLogo}" alt="" style="width:28px;height:28px;object-fit:contain;border-radius:4px;" onerror="this.style.display='none'" />`
      : `<span style="font-size:11px;font-weight:700;color:#555;">${(m.homeTeam||'').slice(0,3).toUpperCase()}</span>`;
    const awayLogo = m.awayLogo
      ? `<img src="${m.awayLogo}" alt="" style="width:28px;height:28px;object-fit:contain;border-radius:4px;" onerror="this.style.display='none'" />`
      : `<span style="font-size:11px;font-weight:700;color:#555;">${(m.awayTeam||'').slice(0,3).toUpperCase()}</span>`;

    // Estado del pronóstico
    let badge = '';
    let borderLeft = '#1c1c1c';

    if (isPend) {
      badge = `<span style="background:#1c2a1c;color:#4ade80;border:1px solid #166534;border-radius:99px;padding:3px 10px;font-size:10px;font-weight:700;letter-spacing:0.05em;">⏳ PENDIENTE</span>`;
      borderLeft = '#166534';
    } else if (p.pointsEarned > 0) {
      const isExact = p.predictedHome === hs && p.predictedAway === as;
      if (isExact) {
        badge = `<span style="background:#1a2a08;color:#E8B84B;border:1px solid #E8B84B66;border-radius:99px;padding:3px 10px;font-size:10px;font-weight:700;letter-spacing:0.05em;">🎯 EXACTO +${p.pointsEarned} pts</span>`;
        borderLeft = '#E8B84B';
      } else {
        badge = `<span style="background:#0f1f0f;color:#4ade80;border:1px solid #16a34a66;border-radius:99px;padding:3px 10px;font-size:10px;font-weight:700;letter-spacing:0.05em;">✅ GANADOR +${p.pointsEarned} pts</span>`;
        borderLeft = '#22c55e';
      }
    } else {
      badge = `<span style="background:#1f0f0f;color:#f87171;border:1px solid #dc262666;border-radius:99px;padding:3px 10px;font-size:10px;font-weight:700;letter-spacing:0.05em;">❌ SIN PUNTOS</span>`;
      borderLeft = '#dc2626';
    }

    return `
      <div class="match-card" style="background:#141414;border:1px solid #1c1c1c;border-left:3px solid ${borderLeft};border-radius:12px;padding:14px 16px;margin-bottom:8px;">
        <!-- Fecha y etapa -->
        <div style="font-size:10px;color:#555;letter-spacing:0.06em;margin-bottom:10px;text-transform:uppercase;">
          ${fmtDate(m.matchDate)} · ${fmtTime(m.matchDate)}
        </div>

        <!-- Equipos y marcadores -->
        <div style="display:flex;align-items:center;gap:0;margin-bottom:10px;">
          <!-- Local -->
          <div style="flex:1;display:flex;flex-direction:column;align-items:flex-start;gap:4px;">
            <div style="display:flex;align-items:center;gap:6px;">
              ${homeLogo}
              <span style="font-size:13px;font-weight:600;color:#e5e5e5;">${m.homeTeam || '?'}</span>
            </div>
          </div>

          <!-- Marcadores -->
          <div style="display:flex;align-items:center;gap:8px;padding:0 12px;">
            <!-- Pronóstico -->
            <div style="text-align:center;">
              <div style="font-size:9px;color:#444;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:3px;">Pronóstico</div>
              <div style="background:#1a1a1a;border:1px solid #2a2a2a;border-radius:8px;padding:6px 12px;font-size:18px;font-weight:700;color:#E8B84B;font-family:'Courier New',monospace;letter-spacing:2px;">
                ${predH} – ${predA}
              </div>
            </div>

            ${!isPend ? `
            <!-- Separador -->
            <div style="color:#333;font-size:12px;">vs</div>

            <!-- Resultado real -->
            <div style="text-align:center;">
              <div style="font-size:9px;color:#444;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:3px;">Resultado</div>
              <div style="background:#0d0d0d;border:1px solid #222;border-radius:8px;padding:6px 12px;font-size:18px;font-weight:700;color:#fff;font-family:'Courier New',monospace;letter-spacing:2px;">
                ${hs} – ${as}
              </div>
            </div>
            ` : `
            <div style="color:#333;font-size:11px;">•••</div>
            `}
          </div>

          <!-- Visitante -->
          <div style="flex:1;display:flex;flex-direction:column;align-items:flex-end;gap:4px;">
            <div style="display:flex;align-items:center;gap:6px;">
              <span style="font-size:13px;font-weight:600;color:#e5e5e5;">${m.awayTeam || '?'}</span>
              ${awayLogo}
            </div>
          </div>
        </div>

        <!-- Badge resultado -->
        <div style="display:flex;align-items:center;justify-content:space-between;">
          ${badge}
          ${!isPend && p.pointsEarned === 0
            ? `<span style="font-size:11px;color:#444;">Pronosticaste: ${ganadorLabel}</span>`
            : ''}
        </div>
      </div>
    `;
  }

  // ── Secciones por etapa ───────────────────────────────────────────────────
  const stageOrder = [
    'Fase de Grupos', 'Ronda de 32', 'Octavos de Final',
    'Cuartos de Final', 'Semifinal', 'Tercer Puesto', 'Final',
  ];

  const sortedStages = Object.keys(byStage).sort((a, b) => {
    const ia = stageOrder.indexOf(a);
    const ib = stageOrder.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });

  const stagesHTML = sortedStages.map(stage => {
    const matches = byStage[stage];
    const ptsStage = matches.reduce((s, p) => s + (p.pointsEarned || 0), 0);
    return `
      <div class="stage-section" style="margin-bottom:24px;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
          <div style="display:flex;align-items:center;gap:8px;">
            <div style="width:3px;height:16px;background:#E8B84B;border-radius:99px;"></div>
            <span style="font-size:11px;font-weight:700;color:#E8B84B;text-transform:uppercase;letter-spacing:0.12em;">${stage}</span>
          </div>
          ${ptsStage > 0
            ? `<span style="font-size:11px;color:#E8B84B;font-weight:700;">+${ptsStage} pts en esta etapa</span>`
            : ''}
        </div>
        ${matches.map(p => matchCard(p)).join('')}
      </div>
    `;
  }).join('');

  // ── Resumen de puntos por tipo ─────────────────────────────────────────────
  const ptsPron  = pronosticos.reduce((s, p) => s + (p.pointsEarned || 0), 0);
  // FIX: antes esto se calculaba como `totalPts - ptsPron`, una resta entre dos
  // fuentes distintas (ProdePoints vs Pronostico.pointsEarned). Si esas dos
  // colecciones no cuadraban perfectamente (por una re-evaluación, un
  // pronóstico duplicado, etc.) el resultado podía dar negativo (ej: -6).
  // `status.puntosBonus` ya es la suma real y directa de los puntos de
  // bonificación (upgrade a Cliente/VIP) desde ProdePoints, así que la usamos
  // directo en vez de inferirla por resta.
  const ptsBonus = status.puntosBonus || 0;
  const acertados = pronosticos.filter(p => p.pointsEarned > 0 && p.matchId?.status === 'finished').length;
  const exactos   = pronosticos.filter(p => {
    const m = p.matchId;
    return p.pointsEarned > 0 && m?.status === 'finished' &&
           p.predictedHome === m.homeScore && p.predictedAway === m.awayScore;
  }).length;
  const evaluados = pronosticos.filter(p => p.matchId?.status === 'finished').length;
  const pendientes = pronosticos.filter(p => p.matchId?.status !== 'finished').length;

  // ── HTML completo ─────────────────────────────────────────────────────────
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Prode Janz — ${nombre}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #080808;
      color: #ffffff;
      font-family: 'Inter', -apple-system, sans-serif;
      font-size: 13px;
      line-height: 1.5;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    .page { max-width: 760px; margin: 0 auto; padding: 32px 28px 48px; }

    /* ── Estilos para impresión ── */
    @media print {
      body { background: #fff; color: #111; }
      .page { padding: 16px; max-width: 100%; }

      /* Evitar que una tarjeta de partido se corte entre páginas */
      .match-card { page-break-inside: avoid; break-inside: avoid; }

      /* Salto de página entre etapas */
      .stage-section { page-break-inside: avoid; break-inside: avoid; }

      /* Header siempre en la primera página */
      .pdf-header { page-break-after: avoid; break-after: avoid; }

      /* Fondo blanco en impresora para ahorrar tinta */
      @page {
        margin: 1.5cm;
        size: A4 portrait;
      }
    }
  </style>
</head>
<body>
<div class="page">

  <!-- ── HEADER ─────────────────────────────────────────────────────────── -->
  <div class="pdf-header" style="position:relative;background:linear-gradient(135deg,#0d1a06 0%,#080808 60%);border:1px solid #1c1c1c;border-radius:20px;padding:28px 28px 24px;margin-bottom:24px;overflow:hidden;">
    <!-- Glow fondo -->
    <div style="position:absolute;top:-60px;right:-60px;width:240px;height:240px;border-radius:50%;background:radial-gradient(circle,rgba(232,184,75,0.07) 0%,transparent 70%);pointer-events:none;"></div>

    <!-- Logo + título -->
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;">
      <div>
        <div style="display:inline-flex;align-items:center;gap:6px;background:rgba(232,184,75,0.12);border:1px solid rgba(232,184,75,0.3);border-radius:99px;padding:4px 12px;margin-bottom:10px;">
          <span style="font-size:11px;">⚽</span>
          <span style="font-size:10px;font-weight:700;color:#E8B84B;letter-spacing:0.12em;text-transform:uppercase;">Mundial 2026</span>
        </div>
        <div style="font-family:'Bebas Neue',cursive;font-size:36px;color:#E8B84B;letter-spacing:2px;line-height:1;">PRODE JANZ</div>
        <div style="font-size:10px;color:#444;letter-spacing:0.1em;text-transform:uppercase;margin-top:2px;">El Mundial se juega en casa</div>
      </div>
      <!-- Avatar -->
      <div style="width:56px;height:56px;background:rgba(232,184,75,0.1);border:1px solid rgba(232,184,75,0.3);border-radius:16px;display:flex;align-items:center;justify-content:center;font-family:'Bebas Neue',cursive;font-size:20px;color:#E8B84B;letter-spacing:1px;flex-shrink:0;">
        ${initials(nombre)}
      </div>
    </div>

    <!-- Nombre + categoría -->
    <div style="margin-bottom:16px;">
      <div style="font-size:22px;font-weight:700;color:#ffffff;margin-bottom:4px;">${nombre}</div>
      <div style="display:inline-flex;align-items:center;gap:6px;background:rgba(0,0,0,0.3);border:1px solid #222;border-radius:99px;padding:4px 12px;">
        <div style="width:6px;height:6px;border-radius:50%;background:${catColor};"></div>
        <span style="font-size:11px;font-weight:700;color:${catColor};letter-spacing:0.08em;">${catLabel.toUpperCase()}</span>
      </div>
    </div>

    <!-- Stats row -->
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:10px;margin-bottom:16px;">
      ${[
        { n: totalPts,   label: 'Puntos totales',  color: '#E8B84B' },
        { n: acertados,  label: 'Acertados',        color: '#22c55e' },
        { n: exactos,    label: 'Exactos',          color: '#E8B84B' },
        { n: pendientes, label: 'Pendientes',       color: '#60a5fa' },
      ].map(({ n, label, color }) => `
        <div style="background:rgba(0,0,0,0.4);border:1px solid #1c1c1c;border-radius:12px;padding:12px 10px;text-align:center;">
          <div style="font-family:'Bebas Neue',cursive;font-size:28px;color:${color};letter-spacing:1px;line-height:1;">${n}</div>
          <div style="font-size:9px;color:#555;margin-top:3px;text-transform:uppercase;letter-spacing:0.06em;">${label}</div>
        </div>
      `).join('')}
    </div>

    <!-- Premio -->
    <div style="background:rgba(232,184,75,0.06);border:1px solid rgba(232,184,75,0.2);border-radius:12px;padding:12px 16px;display:flex;align-items:flex-start;gap:10px;">
      <span style="font-size:18px;flex-shrink:0;">🏆</span>
      <div>
        <div style="font-size:10px;font-weight:700;color:#E8B84B;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:2px;">Tu situación</div>
        <div style="font-size:12px;color:#ccc;">${premio}</div>
        ${proximoPaso ? `<div style="font-size:11px;color:#666;margin-top:4px;">${proximoPaso}</div>` : ''}
      </div>
    </div>
  </div>

  <!-- ── DESGLOSE PUNTOS ─────────────────────────────────────────────────── -->
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:24px;">
    <div style="background:#141414;border:1px solid #1c1c1c;border-radius:14px;padding:16px 18px;">
      <div style="font-size:10px;color:#555;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:8px;">Por pronósticos</div>
      <div style="font-family:'Bebas Neue',cursive;font-size:32px;color:#22c55e;letter-spacing:1px;">${ptsPron} <span style="font-size:16px;">pts</span></div>
      <div style="font-size:11px;color:#444;margin-top:4px;">${evaluados} partidos evaluados</div>
    </div>
    <div style="background:#141414;border:1px solid #1c1c1c;border-radius:14px;padding:16px 18px;">
      <div style="font-size:10px;color:#555;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:8px;">Bonus categoría</div>
      <div style="font-family:'Bebas Neue',cursive;font-size:32px;color:#E8B84B;letter-spacing:1px;">${ptsBonus} <span style="font-size:16px;">pts</span></div>
      <div style="font-size:11px;color:#444;margin-top:4px;">${ptsBonus > 0 ? 'Por compras durante el Mundial' : 'Sin bonus todavía'}</div>
    </div>
  </div>

  <!-- ── PRONÓSTICOS POR ETAPA ───────────────────────────────────────────── -->
  <div style="margin-bottom:24px;">
    <div style="font-family:'Bebas Neue',cursive;font-size:20px;color:#fff;letter-spacing:1.5px;margin-bottom:16px;">
      MIS PRONÓSTICOS
    </div>

    ${pronosticos.length === 0
      ? `<div style="background:#141414;border:1px solid #1c1c1c;border-radius:14px;padding:32px;text-align:center;color:#444;font-size:13px;">
           No hay pronósticos registrados todavía.
         </div>`
      : stagesHTML
    }
  </div>

  <!-- ── LEYENDA ─────────────────────────────────────────────────────────── -->
  <div style="background:#101010;border:1px solid #1c1c1c;border-radius:14px;padding:16px 18px;margin-bottom:24px;">
    <div style="font-size:10px;font-weight:700;color:#444;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:10px;">Leyenda</div>
    <div style="display:flex;gap:16px;flex-wrap:wrap;">
      ${[
        { color: '#E8B84B', label: '🎯 Exacto — acertaste marcador exacto' },
        { color: '#22c55e', label: '✅ Ganador — acertaste el resultado' },
        { color: '#dc2626', label: '❌ Sin puntos — no acertaste' },
        { color: '#166534', label: '⏳ Pendiente — partido no jugado' },
      ].map(({ color, label }) =>
        `<div style="display:flex;align-items:center;gap:6px;font-size:11px;color:#555;">
           <div style="width:3px;height:12px;background:${color};border-radius:99px;flex-shrink:0;"></div>
           ${label}
         </div>`
      ).join('')}
    </div>
  </div>

  <!-- ── FOOTER ─────────────────────────────────────────────────────────── -->
  <div style="text-align:center;padding-top:16px;border-top:1px solid #141414;">
    <div style="font-family:'Bebas Neue',cursive;font-size:18px;color:#E8B84B;letter-spacing:2px;margin-bottom:4px;">JANZ BURGERS</div>
    <div style="font-size:10px;color:#333;letter-spacing:0.08em;">
      Generado el ${new Date().toLocaleDateString('es-AR', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'America/Argentina/Buenos_Aires' })}
    </div>
  </div>

</div>
</body>
</html>`;
}

// ── Generar PDF vía puppeteer ─────────────────────────────────────────────────
async function generateProdePDF(clientId) {
  // Puppeteer es dependencia transitiva de whatsapp-web.js — ya está en node_modules
  const puppeteer = require('puppeteer');
  const mongoose  = require('mongoose');

  // FIX: el clientId llega como String desde la URL. El modelo Pronostico
  // declara clientId como ObjectId, así que Mongoose no matchea si se pasa
  // un String directamente — los pronósticos nuevos no aparecían en el PDF.
  const clientObjId = mongoose.Types.ObjectId.isValid(clientId)
    ? new mongoose.Types.ObjectId(clientId)
    : clientId;

  // Cargar datos
  const [status, pronosticosRaw, cfg] = await Promise.all([
    resolveProdeStatus(clientId),
    Pronostico.find({ clientId: clientObjId })
      .populate('matchId')
      .lean(),
    getProdeConfig(),
  ]);

  if (!status) throw new Error('Cliente no encontrado en el prode');

  // FIX: el .sort({'matchId.matchDate':1}) anterior no ordenaba nada de verdad —
  // Mongoose aplica el sort en el query a la colección Pronostico, ANTES del
  // populate, cuando matchId todavía es sólo un ObjectId (sin matchDate). Por
  // eso los pronósticos no salían ordenados por fecha en el PDF. Ahora se
  // ordena en JS, una vez que matchId ya está populado con los datos del partido.
  const pronosticos = pronosticosRaw.slice().sort((a, b) => {
    const da = a.matchId?.matchDate ? new Date(a.matchId.matchDate).getTime() : 0;
    const db = b.matchId?.matchDate ? new Date(b.matchId.matchDate).getTime() : 0;
    return da - db;
  });

  const html = buildProdeHTML(status, pronosticos, cfg);

  // Lanzar browser temporal solo para el PDF
  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const page = await browser.newPage();

    // Cargar HTML directamente (sin servidor intermedio)
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 15000 });

    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,          // esencial para fondos oscuros
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
    });

    return pdfBuffer;
  } finally {
    await browser.close();
  }
}

module.exports = { generateProdePDF };