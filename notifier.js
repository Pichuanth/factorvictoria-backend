// backend/notifier.js
require("dotenv").config();

// Base de la API de tu propio backend
const API =
  process.env.API_BASE || `http://localhost:${process.env.PORT || 3001}`;

// Configuración (ajústala como quieras)
const BOOKS   = ["Bet365"];                           // añade Betano/Betfair, etc.
const TARGETS = [10, 20, 50, 100];                    // planes pagados
const TOL     = Number(process.env.PARLAY_TOLERANCE || 0.07); // tolerancia 7%
const MIN_LEGS = 3;
const MAX_LEGS = Number(process.env.PARLAY_MAX_LEGS || 6);

// Consulta un objetivo para una casa dada
async function checkPlan(bookmaker, target) {
  const url =
    `${API}/api/parlays?bookmaker=${encodeURIComponent(bookmaker)}` +
    `&target=${target}&tol=${TOL}&minLegs=${MIN_LEGS}&maxLegs=${MAX_LEGS}`;

  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} -> ${url}`);

  const data = await r.json();

  if (data?.found && data?.result?.diffPercent <= (TOL * 100)) {
    // Aquí ya tienes una combinada dentro de la tolerancia
    console.log(`[ALERTA] ${bookmaker} x${target} = ${data.result.product} (±${data.result.diffPercent}%)`);
    console.log(
      data.result.legs
        .map(l => `${l.match_id} | ${l.market}:${l.selection} @${l.price}`)
        .join("  ||  ")
    );

    // TODO: Enviar email real (SendGrid/SES/Gmail API) cuando integres correo
  } else {
    console.log(`[skip] ${bookmaker} x${target} — sin jugada dentro de tolerancia`);
  }
}

// Runner
(async () => {
  for (const b of BOOKS) {
    for (const t of TARGETS) {
      try { await checkPlan(b, t); }
      catch (e) { console.error(`[error] ${b} x${t}:`, e.message); }
    }
  }
})();
