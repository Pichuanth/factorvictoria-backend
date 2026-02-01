// routes/fvpack.js
const express = require("express");
const router = express.Router();

// GET /api/fixture/:id/fvpack
router.get("/fixture/:id/fvpack", async (req, res) => {
  const fixtureId = req.params.id;

  // TODO: aquí luego metemos llamadas reales a API-FOOTBALL:
  // - fixtures statistics
  // - h2h
  // - odds
  // - etc

  return res.json({
    fixtureId,
    last5: { home: {}, away: {} },
    model: { lambdaHome: null, lambdaAway: null, lambdaTotal: null },
    markets: {},
  });
});

module.exports = router;
