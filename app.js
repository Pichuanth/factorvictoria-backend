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

// helper fetch (Node 18+ trae fetch; en Node 20 OK)
function apiSportsBase() {
  return `https://${process.env.APISPORTS_HOST || "v3.football.api-sports.io"}`;
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
// ---------- FIXTURES (por fecha) ----------
// GET /api/fixtures?date=YYYY-MM-DD
app.get("/api/fixtures", async (req, res, next) => {
  try {
    if (!process.env.APISPORTS_KEY) {
      return res.status(400).json({ error: "missing APISPORTS_KEY" });
    }

    const date = String(req.query.date || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: "invalid_date", expected: "YYYY-MM-DD" });
    }

    const host = process.env.APISPORTS_HOST || "v3.football.api-sports.io";
    const url = new URL(`https://${host}/fixtures`);
    url.searchParams.set("date", date);
    // opcional: timezone para que coincida con Chile
    url.searchParams.set("timezone", process.env.APP_TZ || "America/Santiago");

    const r = await fetch(url, {
      headers: { "x-apisports-key": process.env.APISPORTS_KEY }
    });

    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return res.status(r.status).json({ error: "upstream_error", details: data });
    }

    // Devuelve tal cual o lo puedes “limpiar”
    return res.json({
      date,
      results: data?.results ?? null,
      response: data?.response ?? []
    });
  } catch (e) {
    next(e);
  }
});

// ---------- FIXTURES ----------
// Ejemplos:
// /api/fixtures?date=2025-12-17
// /api/fixtures?from=2025-12-17&to=2025-12-18
app.get("/api/fixtures", async (req, res) => {
  try {
    if (!process.env.APISPORTS_KEY) {
      return res.status(400).json({ error: "missing APISPORTS_KEY" });
    }

    const date = String(req.query.date || "").trim();
    const from = String(req.query.from || "").trim();
    const to = String(req.query.to || "").trim();

    // Validación simple YYYY-MM-DD
    const isYMD = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);

    const url = new URL(`${apiSportsBase()}/fixtures`);

    // Prioridad: date, si no from/to
    if (date) {
      if (!isYMD(date)) return res.status(400).json({ error: "invalid_date_format", expected: "YYYY-MM-DD" });
      url.searchParams.set("date", date);
    } else if (from || to) {
      if (from && !isYMD(from)) return res.status(400).json({ error: "invalid_from_format", expected: "YYYY-MM-DD" });
      if (to && !isYMD(to)) return res.status(400).json({ error: "invalid_to_format", expected: "YYYY-MM-DD" });
      if (from) url.searchParams.set("from", from);
      if (to) url.searchParams.set("to", to);
    } else {
      return res.status(400).json({ error: "missing_query", example: "/api/fixtures?date=2025-12-17" });
    }

    // Opcional: timezone para que te devuelva horarios alineados
    url.searchParams.set("timezone", process.env.APP_TZ || "America/Santiago");

    const r = await fetch(url.toString(), {
      headers: { "x-apisports-key": process.env.APISPORTS_KEY },
    });

    const data = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(r.status).json({ error: "upstream_error", details: data });

    return res.json({
      query: { date: date || null, from: from || null, to: to || null },
      results: data?.results ?? null,
      response: data?.response ?? [],
    });
  } catch (e) {
    return res.status(500).json({ error: "server_error", message: e?.message || String(e) });
  }
});
// ---------- FIXTURES ----------
app.get("/api/fixtures", async (req, res, next) => {
  try {
    if (!process.env.APISPORTS_KEY) {
      return res.status(400).json({ error: "missing APISPORTS_KEY" });
    }

    const date = String(req.query.date || "").trim(); // YYYY-MM-DD
    if (!date) return res.status(400).json({ error: "missing_date", hint: "use ?date=YYYY-MM-DD" });

    const host = process.env.APISPORTS_HOST || "v3.football.api-sports.io";
    const url = new URL(`https://${host}/fixtures`);
    url.searchParams.set("date", date);

    // opcionales si quieres filtrar
    if (req.query.league) url.searchParams.set("league", String(req.query.league));
    if (req.query.season) url.searchParams.set("season", String(req.query.season));
    if (req.query.team) url.searchParams.set("team", String(req.query.team));
    if (req.query.timezone) url.searchParams.set("timezone", String(req.query.timezone));

    const r = await fetch(url, {
      headers: { "x-apisports-key": process.env.APISPORTS_KEY },
    });

    const data = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(r.status).json({ error: "upstream_error", details: data });

    return res.json({
      date,
      results: data?.results ?? null,
      response: data?.response ?? [],
    });
  } catch (e) {
    next(e);
  }
});

// ---------- ODDS ----------
// Nota: fixture debe ser ID numérico (ej: 123456), NO una fecha.
app.get("/api/odds", async (req, res, next) => {
  try {
    if (!process.env.APISPORTS_KEY) {
      return res.status(400).json({ error: "missing APISPORTS_KEY" });
    }

    const fixture = String(req.query.fixture || "").trim();
    if (!fixture) return res.status(400).json({ error: "missing_fixture" });
    if (!/^\d+$/.test(fixture)) return res.status(400).json({ error: "fixture_must_be_numeric_id" });

    const url = new URL(`${apiSportsBase()}/odds`);
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

module.exports = app;
