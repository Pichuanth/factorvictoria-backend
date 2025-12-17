// app.js
import express from "express";
import cors from "cors";

// Si en tu index.js tienes pool/pg y otras cosas, muévelas aquí también:
import pg from "pg";
const { Pool } = pg;

const app = express();

app.use(cors());
app.use(express.json());

// ---------- DB (si usas DATABASE_URL) ----------
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

// Health
app.get("/api/health", (req, res) => {
  return res.json({
    ok: true,
    tz: process.env.APP_TZ || process.env.TZ || null,
    hasDb: !!process.env.DATABASE_URL,
    hasApiKey: !!process.env.APISPORTS_KEY,
  });
});

// ===================================================
// PEGA AQUÍ tus endpoints reales (fixtures, odds, etc.)
// ===================================================

// ===== FIXTURES (ejemplo: si ya lo tienes en index.js, pégalo acá tal cual) =====
// app.get("/api/fixtures", async (req, res, next) => { ... });

// ===== ODDS (tu código actual) =====
app.get("/api/odds", async (req, res, next) => {
  try {
    if (!process.env.APISPORTS_KEY) {
      return res.status(400).json({ error: "missing APISPORTS_KEY" });
    }

    const fixture = String(req.query.fixture || "").trim();
    if (!fixture) return res.status(400).json({ error: "missing_fixture" });

    const host = process.env.APISPORTS_HOST || "v3.football.api-sports.io";
    const url = new URL(`https://${host}/odds`);
    url.searchParams.set("fixture", fixture);

    const r = await fetch(url, {
      headers: { "x-apisports-key": process.env.APISPORTS_KEY },
    });

    const data = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(r.status).json({ error: "upstream_error", details: data });

    const responses = data?.response || [];
    if (!responses.length) {
      return res.json({ fixture, found: false, markets: {} });
    }

    const bookmakers = responses[0]?.bookmakers || [];

    let best1x2 = null;
    let bestOU25 = null;

    for (const b of bookmakers) {
      const bookmakerName = b?.bookmaker?.name || "Unknown";
      const bets = b?.bets || [];

      const mw = bets.find(x => (x?.name || "").toLowerCase().includes("match winner"));
      if (mw?.values?.length) {
        const home = mw.values.find(v => (v?.value || "").toLowerCase() === "home")?.odd;
        const draw = mw.values.find(v => (v?.value || "").toLowerCase() === "draw")?.odd;
        const away = mw.values.find(v => (v?.value || "").toLowerCase() === "away")?.odd;

        if (home && draw && away && !best1x2) {
          best1x2 = { home: Number(home), draw: Number(draw), away: Number(away), bookmaker: bookmakerName };
        }
      }

      const ou = bets.find(x => (x?.name || "").toLowerCase().includes("over/under"));
      if (ou?.values?.length) {
        const over25 = ou.values.find(v => String(v?.value || "").includes("Over 2.5"))?.odd;
        const under25 = ou.values.find(v => String(v?.value || "").includes("Under 2.5"))?.odd;

        if (over25 && under25 && !bestOU25) {
          bestOU25 = { over: Number(over25), under: Number(under25), bookmaker: bookmakerName };
        }
      }

      if (best1x2 && bestOU25) break;
    }

    return res.json({
      fixture,
      found: true,
      markets: { "1X2": best1x2, "OU_2_5": bestOU25 },
      raw_bookmakers: bookmakers.length,
    });
  } catch (e) {
    next(e);
  }
});

export default app;
