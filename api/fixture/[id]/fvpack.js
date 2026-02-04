// backend/api/fixture/[id]/fvpack.js
module.exports = async (req, res) => {
  try {
    const fixtureId = Number(req?.query?.id ?? req?.params?.id);
    return res.status(200).json({
      fixtureId: Number.isFinite(fixtureId) ? fixtureId : null,
      model: { lambdaHome: 1.25, lambdaAway: 1.05, lambdaTotal: 2.3 },
      recent: { home: [], away: [] },
      h2h: [],
      markets: {},
    });
  } catch (e) {
    return res.status(200).json({ error: String(e?.message || e) });
  }
};
