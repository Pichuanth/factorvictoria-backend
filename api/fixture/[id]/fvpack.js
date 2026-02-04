// backend/api/fixture/[id]/fvpack.js
module.exports = async (req, res) => {
  try {
    const idRaw = req?.query?.id ?? req?.query?.fixtureId; // soporta ambos por si acaso
    const fixtureId = Number(idRaw);

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
