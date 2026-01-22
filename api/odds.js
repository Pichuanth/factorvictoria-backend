// backend/api/odds.js (Vercel Serverless Function)

module.exports = async (req, res) => {
  try {
    const fixture = req.query.fixture;
    if (!fixture) return res.status(400).json({ error: "fixture is required" });

    const key = process.env.APISPORTS_KEY;
    const host = process.env.APISPORTS_HOST || "v3.football.api-sports.io";

    // ✅ Si no hay key en Vercel, NO crashear
    if (!key) {
      return res.status(200).json({
        found: false,
        markets: {},
        note: "APISPORTS_KEY missing on server (Vercel env var not set).",
      });
    }

    const url = `https://${host}/odds?fixture=${encodeURIComponent(String(fixture))}`;

    const r = await fetch(url, {
      headers: {
        "x-apisports-key": key,
        "x-rapidapi-host": host, // algunos planes lo ignoran, pero no molesta
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

    // Aquí debes normalizar a tu formato {found, markets}
    // Como MVP: si no hay response, found=false
    const response = data?.response || [];
    if (!Array.isArray(response) || response.length === 0) {
      return res.status(200).json({ found: false, markets: {}, raw: data });
    }

    // TODO: Normalización real (depende de cómo venga API-SPORTS odds)
    // Por ahora entregamos raw para validar que llega algo.
    return res.status(200).json({
      found: true,
      markets: {}, // luego lo llenamos
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
