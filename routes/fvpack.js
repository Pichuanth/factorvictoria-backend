const express = require("express");
const router = express.Router();

// GET /api/fixture/:fixtureId/fvpack
router.get("/fixture/:fixtureId/fvpack", async (req, res) => {
  const { fixtureId } = req.params;

  // TODO: acá tu lógica real (API-Football + modelo + markets)
  // Por ahora, responde algo mínimo para comprobar que dejó de ser 404
  return res.json({
    fixtureId: Number(fixtureId),
    model: { lambdaHome: 1.25, lambdaAway: 1.05, lambdaTotal: 2.30 },
    recent: { home: [], away: [] },
    h2h: [],
    markets: {},
  });
});

module.exports = router;
