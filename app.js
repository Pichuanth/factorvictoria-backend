// app.js (CommonJS)
const express = require("express");
const cors = require("cors");
const pg = require("pg");
const fetch = global.fetch || require("node-fetch");

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

// ---------- HEALTH ----------
app.get("/api/health", async (req, res) => {
  let dbOk = false;
  if (pool) {
    try {
      await pool.query("SELECT 1");
      dbOk = true;
    } catch (_) {}
  }

  res.json({
    ok: true,
    tz: process.env.APP_TZ || process.env.TZ || null,
    hasDbUrl: !!process.env.DATABASE_URL,
    dbOk,
    hasApiKey: !!process.env.APISPORTS_KEY,
    now: new Date().toISOString(),
  });
});

// ---------- FIXTURES ----------
app.get("/api/fixtures", async (req, res) => {
  try {
    if (!process.env.APISPORTS_KEY) {
      return res.status(400).json({ error: "missing APISPORTS_KEY" });
    }

    const date = String(req.query.date || "").trim();
    if (!date) {
      return res.status(400).json({ error: "missing_date", example: "YYYY-MM-DD" });
    }

    const host = process.env.APISPORTS_HOST || "v3.football.api-sports.io";
    const url = new URL(`https://${host}/fixtures`);
    url.searchParams.set("date", date);
    url.searchParams.set("timezone", process.env.APP_TZ || "America/Santiago");

    const r = await fetch(url, {
      headers: { "x-apisports-key": process.env.APISPORTS_KEY },
    });

    const data = await r.json();
    if (!r.ok) return res.status(r.status).json(data);

    res.json({
      date,
      results: data?.results || 0,
      fixtures: data?.response || [],
    });
  } catch (e) {
    res.status(500).json({ error: "server_error", message: e.message });
  }
});

// ---------- ODDS ----------
app.get("/api/odds", async (req, res) => {
  try {
    const fixture = String(req.query.fixture || "").trim();
    if (!fixture) return res.status(400).json({ error: "missing_fixture" });

    const host = process.env.APISPORTS_HOST || "v3.football.api-sports.io";
    const url = new URL(`https://${host}/odds`);
    url.searchParams.set("fixture", fixture);

    const r = await fetch(url, {
      headers: { "x-apisports-key": process.env.APISPORTS_KEY },
    });

    const data = await r.json();
    if (!r.ok) return res.status(r.status).json(data);

    res.json(data);
  } catch (e) {
    res.status(500).json({ error: "server_error", message: e.message });
  }
});

module.exports = app;
