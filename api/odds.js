// backend/api/odds.js (Vercel Serverless Function)

function pickBestBookmaker(responseItem) {
  // responseItem.bookmakers: [{ id, name, bets: [...] }]
  const bms = Array.isArray(responseItem?.bookmakers) ? responseItem.bookmakers : [];
  // si existe "1xBet" u otro preferido, lo priorizas
  const preferred = ["1xbet", "bet365", "pinnacle"];
  for (const p of preferred) {
    const found = bms.find((b) => String(b?.name || "").toLowerCase().includes(p));
    if (found) return found;
  }
  return bms[0] || null;
}

function getBet(bookmaker, betName) {
  const bets = Array.isArray(bookmaker?.bets) ? bookmaker.bets : [];
  return bets.find((b) => String(b?.name || "").toLowerCase() === String(betName).toLowerCase()) || null;
}

function valOdd(bet, valueLabel) {
  const values = Array.isArray(bet?.values) ? bet.values : [];
  const v = values.find((x) => String(x?.value) === String(valueLabel));
  const o = v?.odd;
  const n = Number(o);
  return Number.isFinite(n) ? n : null;
}

module.exports = async (req, res) => {
  // CORS allowlist
  const allow = new Set([
    "https://factorvictoria.com",
    "https://www.factorvictoria.com",
    "http://localhost:5173",
  ]);
  const origin = req.headers.origin;
  res.setHeader("Access-Control-Allow-Origin", allow.has(origin) ? origin : "https://factorvictoria.com");
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

    const url = new URL(`https://${host}/odds`);
    url.searchParams.set("fixture", String(fixture));

    const r = await fetch(url.toString(), {
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
    const bm = pickBestBookmaker(item);

    if (!bm) {
      return res.status(200).json({
        found: true,
        markets: {},
        note: "No bookmakers available for this fixture in API-SPORTS response.",
        raw: data,
      });
    }

    const m1x2 = getBet(bm, "Match Winner");
    const mdc = getBet(bm, "Double Chance");
    const mou = getBet(bm, "Goals Over/Under");
    const mbtts = getBet(bm, "Both Teams Score");

    const markets = {
      meta: {
        bookmaker: bm?.name || null,
        fixture: String(fixture),
      },
      "1X2": m1x2
        ? {
            home: valOdd(m1x2, "Home"),
            draw: valOdd(m1x2, "Draw"),
            away: valOdd(m1x2, "Away"),
          }
        : null,
      DC: mdc
        ? {
            home_draw: valOdd(mdc, "Home/Draw"),
            home_away: valOdd(mdc, "Home/Away"),
            draw_away: valOdd(mdc, "Draw/Away"),
          }
        : null,
      OU_25: mou
        ? {
            over: valOdd(mou, "Over 2.5"),
            under: valOdd(mou, "Under 2.5"),
          }
        : null,
      BTTS: mbtts
        ? {
            yes: valOdd(mbtts, "Yes"),
            no: valOdd(mbtts, "No"),
          }
        : null,
    };

    // Limpieza: si todo viene null, lo marcamos “insuficiente”
    const hasAny =
      (markets["1X2"] && (markets["1X2"].home || markets["1X2"].draw || markets["1X2"].away)) ||
      (markets.DC && (markets.DC.home_draw || markets.DC.home_away || markets.DC.draw_away)) ||
      (markets.OU_25 && (markets.OU_25.over || markets.OU_25.under)) ||
      (markets.BTTS && (markets.BTTS.yes || markets.BTTS.no));

    return res.status(200).json({
      found: true,
      markets: hasAny ? markets : {},
      note: hasAny ? undefined : "Odds found but MVP markets missing (try another fixture).",
      raw: data, // déjalo por ahora para debug
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
