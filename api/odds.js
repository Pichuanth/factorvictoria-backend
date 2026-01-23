// backend/api/odds.js (Vercel Serverless Function)

function pickFirstBookmaker(responseItem) {
  const bms = Array.isArray(responseItem?.bookmakers) ? responseItem.bookmakers : [];
  return bms[0] || null;
}

function marketByName(bookmaker, name) {
  const bets = Array.isArray(bookmaker?.bets) ? bookmaker.bets : [];
  return bets.find((b) => String(b?.name || "").toLowerCase() === String(name).toLowerCase()) || null;
}

function valueOdd(market, label) {
  const values = Array.isArray(market?.values) ? market.values : [];
  const v = values.find((x) => String(x?.value || "").toLowerCase() === String(label).toLowerCase());
  const n = v ? Number(v.odd) : null;
  return Number.isFinite(n) ? n : null;
}

module.exports = async (req, res) => {
  // CORS
  const allow = new Set([
    "https://factorvictoria.com",
    "https://www.factorvictoria.com",
    "http://localhost:5173",
  ]);
  const origin = req.headers.origin;
  if (allow.has(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  else res.setHeader("Access-Control-Allow-Origin", "https://factorvictoria.com");

  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-admin-token");

  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const fixture = req.query.fixture;
    if (!fixture) return res.status(400).json({ error: "fixture is required" });

    const key = process.env.APISPORTS_KEY;
    const host = process.env.APISPORTS_HOST || "v3.football.api-sports.io";

    if (!key) {
      return res.status(200).json({
        found: false,
        markets: {},
        note: "APISPORTS_KEY missing on server (Vercel env var not set).",
      });
    }

    const url = `https://${host}/odds?fixture=${encodeURIComponent(String(fixture))}&timezone=America/Santiago`;

    const r = await fetch(url, {
      headers: {
        "x-apisports-key": key,
        "x-rapidapi-host": host,
      },
    });

    const data = await r.json().catch(() => null);

    if (!r.ok) {
      return res.status(200).json({
        found: false,
        markets: {},
        note: `API-SPORTS error ${r.status}`,
        raw: data,
      });
    }

    const response = Array.isArray(data?.response) ? data.response : [];
    if (!response.length) {
      return res.status(200).json({ found: false, markets: {}, raw: data });
    }

    const item = response[0];
    const bm = pickFirstBookmaker(item);
    if (!bm) {
      return res.status(200).json({
        found: true,
        markets: {},
        note: "Odds found but no bookmakers in response.",
        raw: data,
      });
    }

    // Normalización MVP
    const markets = {
      "1X2": {
        home: null,
        draw: null,
        away: null,
      },
      DC: {
        home_draw: null,
        home_away: null,
        draw_away: null,
      },
      OU_25: {
        over: null,
        under: null,
      },
      BTTS: {
        yes: null,
        no: null,
      },
      meta: {
        bookmaker: bm?.name || null,
      },
    };

    const m1x2 = marketByName(bm, "Match Winner");
    if (m1x2) {
      markets["1X2"].home = valueOdd(m1x2, "Home");
      markets["1X2"].draw = valueOdd(m1x2, "Draw");
      markets["1X2"].away = valueOdd(m1x2, "Away");
    }

    const mdc = marketByName(bm, "Double Chance");
    if (mdc) {
      markets.DC.home_draw = valueOdd(mdc, "Home/Draw");
      markets.DC.home_away = valueOdd(mdc, "Home/Away");
      markets.DC.draw_away = valueOdd(mdc, "Draw/Away");
    }

    const mou = marketByName(bm, "Goals Over/Under");
    if (mou) {
      // nos enfocamos solo en 2.5
      markets.OU_25.over = valueOdd(mou, "Over 2.5");
      markets.OU_25.under = valueOdd(mou, "Under 2.5");
    }

    const mbtts = marketByName(bm, "Both Teams Score");
    if (mbtts) {
      markets.BTTS.yes = valueOdd(mbtts, "Yes");
      markets.BTTS.no = valueOdd(mbtts, "No");
    }

    const hasAny =
      (markets["1X2"] && (markets["1X2"].home || markets["1X2"].draw || markets["1X2"].away)) ||
      (markets.DC && (markets.DC.home_draw || markets.DC.home_away || markets.DC.draw_away)) ||
      (markets.OU_25 && (markets.OU_25.over || markets.OU_25.under)) ||
      (markets.BTTS && (markets.BTTS.yes || markets.BTTS.no));

    return res.status(200).json({
      found: true,
      markets: hasAny ? markets : {},
      note: hasAny ? undefined : "Odds found but MVP markets missing (try another fixture).",
      raw: data,
    });
  } catch (err) {
    return res.status(200).json({
      found: false,
      markets: {},
      note: "odds function crashed",
      error: String(err?.message || err),
    });
  }
};
