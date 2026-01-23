// backend/api/odds.js (Vercel Serverless Function)

module.exports = async (req, res) => {
  // --- CORS ---
  const allow = new Set([
    "https://factorvictoria.com",
    "https://www.factorvictoria.com",
    "http://localhost:5173",
  ]);

  const origin = req.headers.origin;
  if (origin && allow.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  } else {
    // fallback (sirve para abrir la URL directo en el navegador)
    res.setHeader("Access-Control-Allow-Origin", "https://factorvictoria.com");
  }

  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-admin-token");

  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const fixture = req.query.fixture;
    if (!fixture) return res.status(400).json({ error: "fixture is required" });

    const key = process.env.APISPORTS_KEY;
    const host = process.env.APISPORTS_HOST || "v3.football.api-sports.io";

    if (!key) {
      return res.status(200).json({
        found: false,
        markets: {},
        note: "APISPORTS_KEY missing on server.",
      });
    }

    const url = `https://${host}/odds?fixture=${encodeURIComponent(String(fixture))}`;

    const r = await fetch(url, {
      headers: {
        "x-apisports-key": key,
        "x-rapidapi-host": host,
      },
    });

    const data = await r.json().catch(() => null);

    if (!r.ok) {
      return res.status(200).json({
        found: false,
        markets: {},
        note: `API-SPORTS error ${r.status}`,
        raw: data,
      });
    }

    const response = data?.response || [];
    if (!Array.isArray(response) || response.length === 0) {
      return res.status(200).json({ found: false, markets: {}, raw: data });
    }

    // MVP: por ahora markets vacío y raw completo
    return res.status(200).json({
      found: true,
      markets: {},
      raw: data,
    });
  } catch (err) {
    return res.status(200).json({
      found: false,
      markets: {},
      note: "odds function crashed",
      error: String(err?.message || err),
    });
  }
};
