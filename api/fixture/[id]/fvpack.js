// backend/api/fixture/[id]/fvpack.js
module.exports = async (req, res) => {
  // ---- CORS ----
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  try {
    const fixtureId = Number(req?.query?.id || req?.params?.id || req?.query?.fixtureId);

    return res.status(200).json({
      fixtureId: Number.isFinite(fixtureId) ? fixtureId : null,
      model: { lambdaHome: 1.25, lambdaAway: 1.05, lambdaTotal: 2.30 },
      recent: { home: [], away: [] },
      h2h: [],
      markets: {},
    });
  } catch (e) {
    return res.status(200).json({ error: String(e?.message || e) });
  }
};
