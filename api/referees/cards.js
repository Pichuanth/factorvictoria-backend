// backend/api/referees/cards.js (Vercel Serverless Function)

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
    res.setHeader("Access-Control-Allow-Origin", "https://factorvictoria.com");
  }

  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-admin-token");

  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const key = process.env.APISPORTS_KEY;
    const host = process.env.APISPORTS_HOST || "v3.football.api-sports.io";
    const tz = process.env.APP_TZ || "America/Santiago";

    if (!key) {
      return res.status(200).json({
        message: "APISPORTS_KEY missing on server.",
        topReferees: [],
        fixturesScanned: 0,
        query: { from: req.query.from, to: req.query.to, country: req.query.country || null },
      });
    }

    const from = String(req.query.from || "").trim();
    const to = String(req.query.to || "").trim();
    const country = String(req.query.country || "").trim();

    if (!from || !to) {
      return res.status(400).json({ error: "from and to are required (YYYY-MM-DD)" });
    }

    // MVP: por ahora solo devolvemos fixtures del rango y de ahí construyes ranking (luego lo implementamos)
    const params = new URLSearchParams();
    params.set("from", from);
    params.set("to", to);
    params.set("timezone", tz);
    if (country) params.set("country", country);

    const url = `https://${host}/fixtures?${params.toString()}`;

    const r = await fetch(url, {
      headers: { "x-apisports-key": key, "x-rapidapi-host": host },
    });

    const data = await r.json().catch(() => null);

    if (!r.ok) {
      return res.status(200).json({
        message: `API-SPORTS error ${r.status}`,
        raw: data,
        topReferees: [],
        fixturesScanned: 0,
        query: { from, to, country: country || null },
      });
    }

    const fixtures = Array.isArray(data?.response) ? data.response : [];

    // MVP placeholder
    return res.status(200).json({
      query: { from, to, country: country || null },
      fixturesScanned: fixtures.length,
      topReferees: [],
      recommended: null,
      message: "MVP: endpoint OK (ranking de árbitros se implementa después).",
    });
  } catch (err) {
    return res.status(200).json({
      message: "referees/cards crashed",
      error: String(err?.message || err),
      topReferees: [],
      fixturesScanned: 0,
      query: { from: req.query.from, to: req.query.to, country: req.query.country || null },
    });
  }
};
