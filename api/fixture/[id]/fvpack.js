// backend/api/fixture/[fixtureId]/fvpack.js
module.exports = async (req, res) => {
  try {
    const fixtureId = Number(req.query.fixtureId || req.params?.fixtureId);

    return res.status(200).json({
      fixtureId,
      model: { lambdaHome: 1.25, lambdaAway: 1.05, lambdaTotal: 2.30 },
      recent: { home: [], away: [] },
      h2h: [],
      markets: {},
    });
  } catch (e) {
    return res.status(200).json({
      error: String(e?.message || e),
    });
  }
};
