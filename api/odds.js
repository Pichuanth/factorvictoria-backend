const express = require("express");
const fetch = require("node-fetch");

const router = express.Router();

router.get("/odds", async (req, res) => {
  try {
    const fixture = req.query.fixture;
    if (!fixture) return res.status(400).json({ error: "fixture is required" });

    const key = process.env.APISPORTS_KEY;
    const host = process.env.APISPORTS_HOST || "v3.football.api-sports.io";
    if (!key) return res.status(500).json({ error: "Missing APISPORTS_KEY" });

    const url = `https://${host}/odds?fixture=${encodeURIComponent(fixture)}`;

    const r = await fetch(url, {
      headers: { "x-apisports-key": key, "x-rapidapi-host": host },
    });

    const data = await r.json().catch(() => null);
    if (!r.ok) {
      return res.status(r.status).json({ error: data?.message || "APISPORTS error", raw: data });
    }

    // Normaliza a { found, markets }
    const response = data?.response || [];
    const first = response[0];
    const bookmakers = first?.bookmakers || [];

    const markets = {};
    for (const bk of bookmakers) {
      for (const m of bk?.bets || []) {
        const name = m?.name;
        const values = m?.values || [];
        if (!name || !values.length) continue;

        // clave simple por mercado
        let keyName = name;
        if (name.toLowerCase().includes("match winner")) keyName = "1X2";
        if (name.toLowerCase().includes("double chance")) keyName = "1X";
        if (name.toLowerCase().includes("goals over/under")) keyName = "OU";
        if (name.toLowerCase().includes("both teams score")) keyName = "BTTS";

        markets[keyName] ||= {};
        for (const v of values) {
          const label = v?.value;
          const odd = v?.odd;
          if (!label || !odd) continue;
          markets[keyName][label] = odd;
        }
      }
    }

    return res.json({
      found: Object.keys(markets).length > 0,
      fixture: String(fixture),
      markets,
    });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

module.exports = router;
