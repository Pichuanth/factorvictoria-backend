// app.js (CommonJS)
const express = require("express");
const cors = require("cors");
const pg = require("pg");

const { Pool } = pg;

const app = express();

app.use(cors());
app.use(express.json());

// ---------- DB (opcional) ----------
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    })
  : null;

function isYYYYMMDD(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
}

// ---------- HEALTH ----------
app.get("/api/health", async (req, res) => {
  let dbOk = false;
  if (pool) {
    try {
      await pool.query("SELECT 1");
      dbOk = true;
    } catch (e) {
      dbOk = false;
    }
  }

  return res.json({
    ok: true,
    tz: process.env.APP_TZ || process.env.TZ || null,
    hasDbUrl: !!process.env.DATABASE_URL,
    dbOk,
    hasApiKey: !!process.env.APISPORTS_KEY,
    hasHost: !!process.env.APISPORTS_HOST,
    now: new Date().toISOString(),
  });
});

// ---------- FIXTURES (API-FOOTBALL) ----------
// Uso:
//  - /api/fixtures?date=YYYY-MM-DD
//  - /api/fixtures?from=YYYY-MM-DD&to=YYYY-MM-DD
app.get("/api/fixtures", async (req, res, next) => {
  try {
    if (!process.env.APISPORTS_KEY) {
      return res.status(400).json({ error: "missing APISPORTS_KEY" });
    }

    const date = req.query.date ? String(req.query.date).trim() : null;
    const from = req.query.from ? String(req.query.from).trim() : null;
    const to = req.query.to ? String(req.query.to).trim() : null;

    // Validación básica
    if (date && !isYYYYMMDD(date)) {
      return res.status(400).json({ error: "invalid_date_format", expected: "YYYY-MM-DD" });
    }
    if ((from || to) && (!isYYYYMMDD(from) || !isYYYYMMDD(to))) {
      return res.status(400).json({ error: "invalid_from_to_format", expected: "YYYY-MM-DD" });
    }
    if (!date && !(from && to)) {
      return res.status(400).json({
        error: "missing_params",
        usage: ["/api/fixtures?date=YYYY-MM-DD", "/api/fixtures?from=YYYY-MM-DD&to=YYYY-MM-DD"],
      });
    }

    const host = process.env.APISPORTS_HOST || "v3.football.api-sports.io";
    const url = new URL(`https://${host}/fixtures`);

    if (date) url.searchParams.set("date", date);
    if (from && to) {
      url.searchParams.set("from", from);
      url.searchParams.set("to", to);
    }

    const r = await fetch(url, {
      headers: { "x-apisports-key": process.env.APISPORTS_KEY },
    });

    const data = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(r.status).json({ error: "upstream_error", details: data });

    return res.json({
      ok: true,
      query: { date, from, to },
      results: data?.results ?? null,
      response: data?.response ?? [],
    });
  } catch (e) {
    next(e);
  }
});

// ---------- ODDS ----------
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

      const mw = bets.find((x) => (x?.name || "").toLowerCase().includes("match winner"));
      if (mw?.values?.length) {
        const home = mw.values.find((v) => (v?.value || "").toLowerCase() === "home")?.odd;
        const draw = mw.values.find((v) => (v?.value || "").toLowerCase() === "draw")?.odd;
        const away = mw.values.find((v) => (v?.value || "").toLowerCase() === "away")?.odd;

        if (home && draw && away && !best1x2) {
          best1x2 = { home: Number(home), draw: Number(draw), away: Number(away), bookmaker: bookmakerName };
        }
      }

      const ou = bets.find((x) => (x?.name || "").toLowerCase().includes("over/under"));
      if (ou?.values?.length) {
        const over25 = ou.values.find((v) => String(v?.value || "").includes("Over 2.5"))?.odd;
        const under25 = ou.values.find((v) => String(v?.value || "").includes("Under 2.5"))?.odd;

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

// ---------- Error handler ----------
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "server_error", message: err?.message || String(err) });
});

module.exports = app;
