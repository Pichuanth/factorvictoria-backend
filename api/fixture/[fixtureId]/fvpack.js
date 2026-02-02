module.exports = async (req, res) => {
  // CORS básico
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

  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-admin-token");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const fixtureId = Number(req.query.fixtureId || req.query.fixtureid || req.query.id || req.query.fixture || req.params?.fixtureId);

    // En Vercel, el parámetro normalmente viene en req.query.fixtureId (depende del runtime)
    // Así que mejor: lo sacamos del path:
    const path = req.url || "";
    const m = path.match(/\/fixture\/(\d+)\/fvpack/);
    const fid = fixtureId || (m ? Number(m[1]) : null);

    return res.status(200).json({
      fixtureId: Number(fid),
      model: { lambdaHome: 1.25, lambdaAway: 1.05, lambdaTotal: 2.3 },
      recent: { home: [], away: [] },
      h2h: [],
      markets: {},
    });
  } catch (err) {
    return res.status(200).json({ error: String(err?.message || err) });
  }
};
