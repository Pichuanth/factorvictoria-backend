const express = require("express");
const router = express.Router();

const APISPORTS_HOST = process.env.APISPORTS_HOST || "v3.football.api-sports.io";
const APISPORTS_KEY = process.env.APISPORTS_KEY;

function normalizeOdds(apiData) {
  const response = apiData?.response || [];
  const row = Array.isArray(response) ? response[0] : null;

  const bookmakers = row?.bookmakers || [];
  const book = bookmakers[0] || null;
  const bets = book?.bets || [];

  const toNum = (x) => {
    const n = Number(String(x).replace(",", "."));
    return Number.isFinite(n) ? n : null;
  };

  const mapValues = (bet) => {
    const values = bet?.values || [];
    const out = {};
    for (const v of values) {
      const label = String(v?.value || "").trim();
      const odd = toNum(v?.odd);
      if (label && odd) out[label] = odd;
    }
    return out;
  };

  const findBet = (includes) =>
    bets.find((b) => String(b?.name || "").toLowerCase().includes(String(includes).toLowerCase()));

  return {
    found: !!book,
    bookmaker: book ? { id: book.id, name: book.name } : null,
    markets: {
      "1X2": mapValues(findBet("match winner")),
      "1X": mapValues(findBet("double chance")),
      "OU": mapValues(findBet("goals over/under")),
      "BTTS": mapValues(findBet("both teams score")),
      "CARDS_OU": mapValues(findBet("cards over/under")),
      "CORNERS_OU": mapValues(findBet("corners over/under")),
    },
  };
}

router.get("/", async (req, res) => {
  try {
    const fixture = String(req.query.fixture || "").trim();
    if (!fixture) return res.status(400).json({ found: false, error: "fixture is required", markets: {} });
    if (!APISPORTS_KEY) return res.json({ found: false, markets: {}, note: "APISPORTS_KEY missing" });

    const url = new URL(`https://${APISPORTS_HOST}/odds`);
    url.searchParams.set("fixture", fixture);

    const r = await fetch(url.toString(), {
      headers: { "x-apisports-key": APISPORTS_KEY },
    });

    if (!r.ok) return res.status(r.status).json({ found: false, markets: {}, http: r.status });

    const data = await r.json();
    const pack = normalizeOdds(data);

    return res.json({ fixtureId: fixture, ...pack, fetchedAt: Date.now() });
  } catch (e) {
    return res.status(500).json({ found: false, markets: {}, error: String(e?.message || e) });
  }
});

module.exports = router;
