const cors = require("../../_cors");
/**
 * /api/fixture/:id/fvpack
 * Devuelve un "pack" rápido para el panel de estadísticas del Comparator:
 * -_toggle_ últimos 5 (forma + goles a favor/contra)
 * - xG (lambdaHome/lambdaAway/lambdaTotal) con heurística simple basada en últimos 5
 *
 * Nota: NO toca BD. Solo API-Football vía RapidAPI (misma config que statistics.js).
 */

function num(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function safeAvg(arr) {
  const xs = arr.filter((v) => typeof v === "number" && Number.isFinite(v));
  if (!xs.length) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function buildForm(teamId, lastFixtures) {
  // lastFixtures: array de fixtures (ordenados del más reciente al más antiguo)
  const form = [];
  let gf = 0;
  let ga = 0;

  for (const fx of lastFixtures) {
    const homeId = fx?.teams?.home?.id;
    const awayId = fx?.teams?.away?.id;
    const gh = num(fx?.goals?.home);
    const ga_ = num(fx?.goals?.away);

    if (homeId == null || awayId == null || gh == null || ga_ == null) continue;

    const isHome = homeId === teamId;
    const scored = isHome ? gh : ga_;
    const conceded = isHome ? ga_ : gh;

    gf += scored;
    ga += conceded;

    if (scored > conceded) form.push("W");
    else if (scored < conceded) form.push("L");
    else form.push("D");
  }

  return {
    form: form.length ? form.join("-") : null,
    gf,
    ga,
    played: form.length,
  };
}

function estimateLambdas(homeForm, awayForm) {
  // Heurística: promedio de GF del equipo + promedio de GA del rival / 2.
  // Ajuste leve por localía.
  const homeGfAvg = homeForm.played ? homeForm.gf / homeForm.played : null;
  const homeGaAvg = homeForm.played ? homeForm.ga / homeForm.played : null;
  const awayGfAvg = awayForm.played ? awayForm.gf / awayForm.played : null;
  const awayGaAvg = awayForm.played ? awayForm.ga / awayForm.played : null;

  let lambdaHome = null;
  let lambdaAway = null;

  if (homeGfAvg != null && awayGaAvg != null) {
    lambdaHome = (homeGfAvg + awayGaAvg) / 2;
    lambdaHome += 0.15; // ventaja local (muy suave)
  }

  if (awayGfAvg != null && homeGaAvg != null) {
    lambdaAway = (awayGfAvg + homeGaAvg) / 2;
  }

  // Clamp suave para evitar extremos absurdos en muestra chica
  const clamp = (x) => (x == null ? null : Math.max(0.2, Math.min(3.5, x)));

  lambdaHome = clamp(lambdaHome);
  lambdaAway = clamp(lambdaAway);

  const lambdaTotal =
    lambdaHome != null && lambdaAway != null ? clamp(lambdaHome + lambdaAway) : null;

  return { lambdaHome, lambdaAway, lambdaTotal };
}

module.exports = async (req, res) => {
  await cors(req, res);


  try {
  const fixtureId = req.query?.fixtureId || req.query?.id;
  if (!fixtureId) return res.status(400).json({ ok: false, error: "Missing fixture id" });

  const KEY = process.env.APISPORTS_KEY;
  const HOST = process.env.APISPORTS_HOST || "v3.football.api-sports.io";

  if (!KEY) {
    // Fallback controlado (para dev sin key)
    return res.status(200).json({
      ok: true,
      fixtureId,
      model: { lambdaHome: 1.25, lambdaAway: 1.05, lambdaTotal: 2.30 },
      last5: null,
      meta: { note: "APISPORTS_KEY missing; fallback model only" },
    });
  }

  const headers = { "x-rapidapi-key": KEY, "x-rapidapi-host": HOST };

  // 1) Fixture base (para obtener team IDs)
  const fxRes = await fetch(`https://${HOST}/fixtures?id=${encodeURIComponent(fixtureId)}`, {
    headers,
  });
  if (!fxRes.ok) {
    return res.status(fxRes.status).json({ ok: false, error: `Fixture fetch HTTP ${fxRes.status}` });
  }
  const fxJson = await fxRes.json();
  const fx = fxJson?.response?.[0];
  const homeId = fx?.teams?.home?.id;
  const awayId = fx?.teams?.away?.id;

  if (!homeId || !awayId) {
    return res.status(200).json({
      ok: true,
      fixtureId,
      model: { lambdaHome: 1.25, lambdaAway: 1.05, lambdaTotal: 2.30 },
      last5: null,
      meta: { note: "Missing team ids in fixture" },
    });
  }

  // 2) Últimos 5 partidos de cada equipo (global, sin filtrar liga para evitar 0 resultados)
  const [homeLastRes, awayLastRes] = await Promise.all([
    fetch(`https://${HOST}/fixtures?team=${homeId}&last=5`, { headers }),
    fetch(`https://${HOST}/fixtures?team=${awayId}&last=5`, { headers }),
  ]);

  const homeLastJson = homeLastRes.ok ? await homeLastRes.json() : null;
  const awayLastJson = awayLastRes.ok ? await awayLastRes.json() : null;

  const homeLast = Array.isArray(homeLastJson?.response) ? homeLastJson.response : [];
  const awayLast = Array.isArray(awayLastJson?.response) ? awayLastJson.response : [];

  const homeForm = buildForm(homeId, homeLast);
  const awayForm = buildForm(awayId, awayLast);

  const model = estimateLambdas(homeForm, awayForm);

  const last5 = {
    home: { form: homeForm.form, gf: homeForm.gf, ga: homeForm.ga, played: homeForm.played },
    away: { form: awayForm.form, gf: awayForm.gf, ga: awayForm.ga, played: awayForm.played },
    // corners/cards se dejan para etapa 2 (necesita statistics/eventos por fixture)
    cornersAvg: null,
    cardsAvg: null,
  };

  return res.status(200).json({
    ok: true,
    fixtureId,
    model,
    last5,
    meta: { homeId, awayId },
  });
  } catch (err) {
    console.error('[fvpack] error', err);
    return res.status(500).json({ ok: false, error: 'FVPACK_FAILED' });
  }
}