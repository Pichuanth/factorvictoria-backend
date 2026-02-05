// backend/api/fixture/[id]/fvpack.js
const cors = require("../../_cors");

module.exports = async (req, res) => {
  if (cors(req, res)) return;

  try {
    const fixtureId = Number(req?.query?.id || req?.params?.id);

    return res.status(200).json({
      fixtureId: Number.isFinite(fixtureId) ? fixtureId : null,
      model: { lambdaHome: 1.25, lambdaAway: 1.05, lambdaTotal: 2.30 },
      recent: { home: [], away: [] },
      h2h: [],
      markets: {},
    });
  } catch (e) {
    return res.status(500).json({ error: "server_error", message: String(e?.message || e) });
  }
};
