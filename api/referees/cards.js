import cors from "../_cors.js";

/**
 * /api/referees/cards
 * Ranking simple de árbitros con más tarjetas en un rango de fechas (y opcional country).
 *
 * Query:
 * - from=YYYY-MM-DD
 * - to=YYYY-MM-DD
 * - country=Argentina (opcional)
 * - limit=10 (opcional)
 *
 * Nota: Este ranking requiere llamar eventos por fixture (costoso). Para no reventar,
 * se limita la muestra de fixtures escaneados.
 */

function num(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

async function fetchJson(url, headers) {
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function poolMap(items, worker, concurrency = 5) {
  const out = [];
  let i = 0;
  const runners = new Array(Math.min(concurrency, items.length)).fill(0).map(async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
  return out;
}

export default async function handler(req, res) {
  await cors(req, res);

  const KEY = process.env.APISPORTS_KEY;
  const HOST = process.env.APISPORTS_HOST || "v3.football.api-sports.io";
  if (!KEY) return res.status(500).json({ ok: false, error: "Missing APISPORTS_KEY" });

  const headers = { "x-rapidapi-key": KEY, "x-rapidapi-host": HOST };

  const from = req.query?.from;
  const to = req.query?.to;
  const country = req.query?.country;
  const limit = num(req.query?.limit) || 10;

  if (!from || !to) {
    return res.status(400).json({ ok: false, error: "Missing from/to (YYYY-MM-DD)" });
  }

  // 1) Lista de fixtures en rango (terminados o en general; filtramos luego)
  const params = new URLSearchParams({ from, to });
  if (country) params.set("country", country);

  let fxJson;
  try {
    fxJson = await fetchJson(`https://${HOST}/fixtures?${params.toString()}`, headers);
  } catch (e) {
    return res.status(500).json({ ok: false, error: `Fixtures fetch failed: ${String(e?.message || e)}` });
  }

  const fixtures = Array.isArray(fxJson?.response) ? fxJson.response : [];

  // Filtra a fixtures que tengan referee y un estado "FT" / "AET" / "PEN"
  const finished = fixtures.filter((f) => {
    const st = f?.fixture?.status?.short;
    return !!f?.fixture?.referee && (st === "FT" || st === "AET" || st === "PEN");
  });

  // Para MVP: cap a 60 fixtures escaneados por ranking (evita timeouts y límites)
  const CAP = 60;
  const sample = finished.slice(0, CAP);

  const agg = new Map(); // referee -> {name, cards, games}
  const results = await poolMap(
    sample,
    async (fx) => {
      const id = fx?.fixture?.id;
      const ref = fx?.fixture?.referee || "Unknown";
      if (!id) return null;

      try {
        const ev = await fetchJson(`https://${HOST}/fixtures/events?fixture=${id}`, headers);
        const events = Array.isArray(ev?.response) ? ev.response : [];
        const cards = events.filter((e) => e?.type === "Card").length;

        const prev = agg.get(ref) || { name: ref, cards: 0, games: 0 };
        prev.cards += cards;
        prev.games += 1;
        agg.set(ref, prev);

        return { id, ref, cards };
      } catch {
        // si falla un fixture, lo ignoramos
        return null;
      }
    },
    5
  );

  const top = Array.from(agg.values())
    .map((r) => ({
      ...r,
      cardsPerGame: r.games ? r.cards / r.games : null,
    }))
    .sort((a, b) => (b.cards || 0) - (a.cards || 0))
    .slice(0, limit);

  return res.status(200).json({
    ok: true,
    from,
    to,
    country: country || null,
    fixturesTotal: fixtures.length,
    fixturesFinished: finished.length,
    fixturesScanned: sample.length,
    topReferees: top,
    meta: { cap: CAP },
  });
}
