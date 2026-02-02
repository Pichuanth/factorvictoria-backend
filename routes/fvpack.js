// routes/fvpack.js
const express = require("express");
const router = express.Router();

/**
 * GET /api/fixture/:fixtureId/fvpack
 * Devuelve un "pack" para el modelo FV (aunque sea básico al principio)
 */
router.get("/fixture/:fixtureId/fvpack", async (req, res) => {
  try {
    const { fixtureId } = req.params;
    if (!fixtureId) return res.status(400).json({ error: "fixtureId required" });

    // MVP: devuelve algo válido aunque aún no tengas stats reales
    // (después lo conectamos a API-FOOTBALL / BD)
    return res.json({
      fixtureId: Number(fixtureId) || fixtureId,
      last5: {
        home: { form: "--", gf: null, ga: null, avgCorners: null, avgCards: null },
        away: { form: "--", gf: null, ga: null, avgCorners: null, avgCards: null },
      },
      model: { lambdaHome: null, lambdaAway: null, lambdaTotal: null },
      markets: {},
    });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

module.exports = router;
