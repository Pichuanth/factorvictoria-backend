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

function apiSportsBase() {
  return `https://${process.env.APISPORTS_HOST || "v3.football.api-sports.io"}`;
}

// Fetch con timeout (clave para evitar 504 en Vercel)
async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const r = await fetch(url, { ...options, signal: controller.signal });
    const data = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, data };
  } finally {
    clearTimeout(t);
  }
}

// ---------- HEALTH ----------
app.get("/api/health", async (req, res) => {
  let dbOk = false;

  if (pool) {
    try {
      // ping rápido
      await Promise.race([
        pool.query("SELECT 1"),
        new Promise((_, rej) => setTimeout(() => rej(new Error("db_timeout")), 1500)),
      ]);
      dbOk = true;
    } catch {
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

// ---------- FIXTURES (UNIFICADO) ----------
// Ejemplos:
// /api/fixtures?date=2025-12-19
// /api/fixtures?from=2025-12-19&to=2025-12-20
app.get("/api/fixtures", async (req, res) => {
  try {
    if (!process.env.APISPORTS_KEY) {
      return res.status(400).json({ error: "missing_APISPORTS_KEY" });
    }

    const date = String(req.query.date || "").trim();
    const from = String(req.query.from || "").trim();
    const to = String(req.query.to || "").trim();

    const isYMD = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);

    const url = new URL(`${apiSportsBase()}/fixtures`);

    if (date) {
      if (!isYMD(date)) {
        return res.status(400).json({ error: "invalid_date_format", expected: "YYYY-MM-DD" });
      }
      url.searchParams.set("date", date);
    } else if (from || to) {
      if (from && !isYMD(from)) {
        return res.status(400).json({ error: "invalid_from_format", expected: "YYYY-MM-DD" });
      }
      if (to && !isYMD(to)) {
        return res.status(400).json({ error: "invalid_to_format", expected: "YYYY-MM-DD" });
      }
      if (from) url.searchParams.set("from", from);
      if (to) url.searchParams.set("to", to);
    } else {
      return res.status(400).json({ error: "missing_query", example: "/api/fixtures?date=2025-12-19" });
    }

    // timezone (Chile)
    url.searchParams.set("timezone", process.env.APP_TZ || "America/Santiago");

    const { ok, status, data } = await fetchJsonWithTimeout(
      url.toString(),
      { headers: { "x-apisports-key": process.env.APISPORTS_KEY } },
      8000
    );

    if (!ok) {
      return res.status(status).json({
        error: "upstream_error",
        status,
        details: data,
      });
    }

    return res.json({
      query: { date: date || null, from: from || null, to: to || null },
      results: data?.results ?? null,
      response: data?.response ?? [],
    });
  } catch (e) {
    // Si el fetch fue abortado por timeout, devolvemos 504 controlado (no el de Vercel)
    if (String(e?.name) === "AbortError") {
      return res.status(504).json({
        error: "apisports_timeout",
        message: "API-FOOTBALL no respondió a tiempo (timeout). Intenta nuevamente.",
      });
    }
    return res.status(500).json({ error: "server_error", message: e?.message || String(e) });
  }
});

// ---------- ODDS ----------
app.get("/api/odds", async (req, res) => {
  try {
    if (!process.env.APISPORTS_KEY) {
      return res.status(400).json({ error: "missing_APISPORTS_KEY" });
    }

    const fixture = String(req.query.fixture || "").trim();
    if (!fixture) return res.status(400).json({ error: "missing_fixture" });
    if (!/^\d+$/.test(fixture)) return res.status(400).json({ error: "fixture_must_be_numeric_id" });

    const url = new URL(`${apiSportsBase()}/odds`);
    url.searchParams.set("fixture", fixture);

    const { ok, status, data } = await fetchJsonWithTimeout(
      url.toString(),
      { headers: { "x-apisports-key": process.env.APISPORTS_KEY } },
      8000
    );

    if (!ok) {
      return res.status(status).json({ error: "upstream_error", status, details: data });
    }

    const responses = data?.response || [];
    if (!responses.length) return res.json({ fixture, found: false, markets: {} });

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
    if (String(e?.name) === "AbortError") {
      return res.status(504).json({
        error: "apisports_timeout",
        message: "API-FOOTBALL no respondió a tiempo (timeout). Intenta nuevamente.",
      });
    }
    return res.status(500).json({ error: "server_error", message: e?.message || String(e) });
  }
});

module.exports = app;
