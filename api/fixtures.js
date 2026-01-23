// backend/api/fixtures.js (Vercel Serverless Function)

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
        items: [],
        note: "APISPORTS_KEY missing on server.",
      });
    }

    // --- params ---
    const from = String(req.query.from || "").trim(); // YYYY-MM-DD
    const to = String(req.query.to || "").trim();     // YYYY-MM-DD
    const country = String(req.query.country || "").trim(); // "Chile" etc.
    const q = String(req.query.q || "").trim(); // texto libre

    // Reglas mínimas: desde/hasta requeridos para tu frontend actual
    if (!from || !to) {
      return res.status(400).json({ error: "from and to are required (YYYY-MM-DD)" });
    }

    // API-Sports Fixtures soporta from/to en muchos planes, y timezone como query
    const apiParams = new URLSearchParams();
    apiParams.set("from", from);
    apiParams.set("to", to);
    apiParams.set("timezone", tz);

    // Si viene country, lo usamos como filtro principal
    // (API-Sports suele filtrar por league/country vía "league", pero "country" existe en varios endpoints;
    // si tu plan no lo soporta, lo filtramos después en backend.)
    if (country) apiParams.set("country", country);

    const url = `https://${host}/fixtures?${apiParams.toString()}`;

    const r = await fetch(url, {
      headers: {
        "x-apisports-key": key,
        "x-rapidapi-host": host,
      },
    });

    const data = await r.json().catch(() => null);

    if (!r.ok) {
      return res.status(200).json({
        items: [],
        note: `API-SPORTS error ${r.status}`,
        raw: data,
      });
    }

    const response = Array.isArray(data?.response) ? data.response : [];

    // --- filtro texto libre en backend (para tu input "q") ---
    let items = response;

    if (q) {
      const needle = q.toLowerCase();
      items = items.filter((fx) => {
        const league = fx?.league?.name || "";
        const countryName = fx?.league?.country || "";
        const home = fx?.teams?.home?.name || "";
        const away = fx?.teams?.away?.name || "";
        const blob = `${league} ${countryName} ${home} ${away}`.toLowerCase();
        return blob.includes(needle);
      });
    }

    // Normaliza a tu formato esperado por frontend
    return res.status(200).json({
      items,
      meta: {
        from,
        to,
        country: country || null,
        q: q || null,
        count: items.length,
        tz,
      },
    });
  } catch (err) {
    // ESTE catch evita el 500 visible
    return res.status(200).json({
      items: [],
      error: "fixtures function crashed",
      detail: String(err?.message || err),
    });
  }
};
