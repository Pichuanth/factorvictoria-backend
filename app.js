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

function isYMD(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
}

function addDaysYMD(ymd, days) {
  const d = new Date(`${ymd}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function diffDays(fromYMD, toYMD) {
  const a = new Date(`${fromYMD}T00:00:00.000Z`).getTime();
  const b = new Date(`${toYMD}T00:00:00.000Z`).getTime();
  return Math.floor((b - a) / (24 * 3600 * 1000));
}

function apisportsHeaders() {
  const API_KEY = process.env.APISPORTS_KEY;
  const API_HOST = process.env.APISPORTS_HOST || "v3.football.api-sports.io";

  // Para cubrir ambos escenarios:
  // - API-Sports directo: x-apisports-key
  // - RapidAPI: x-rapidapi-key + x-rapidapi-host
  return {
    "x-apisports-key": API_KEY,
    "x-rapidapi-key": API_KEY,
    "x-rapidapi-host": API_HOST,
  };
}

function normalizeFixtureItems(responseArray) {
  // Normaliza a un formato consistente para el frontend si quieres usar data.items
  const response = Array.isArray(responseArray) ? responseArray : [];
  return response.map((it) => {
    const f = it.fixture || {};
    const lg = it.league || {};
    const teams = it.teams || {};
    const goals = it.goals || {};

    return {
      id: f.id,
      date: f.date,
      timestamp: f.timestamp,
      status: f.status?.short,
      league: {
        id: lg.id,
        name: lg.name,
        country: lg.country,
        round: lg.round,
      },
      country: lg.country,
      teams: {
        home: teams.home
          ? { id: teams.home.id, name: teams.home.name, logo: teams.home.logo }
          : null,
        away: teams.away
          ? { id: teams.away.id, name: teams.away.name, logo: teams.away.logo }
          : null,
      },
      goals: {
        home: goals.home,
        away: goals.away,
      },
    };
  });
}

// ---------- HEALTH ----------
app.get("/api/health", async (req, res) => {
  let dbOk = false;

  if (pool) {
    try {
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

// ---------- FIXTURES ----------
// /api/fixtures?date=2025-12-20
// /api/fixtures?from=2025-12-20&to=2025-12-21
// Opcional: /api/fixtures?from=...&to=...&country=England
// Opcional: /api/fixtures?date=...&q=arsenal
app.get("/api/fixtures", async (req, res) => {
  try {
    if (!process.env.APISPORTS_KEY) {
      return res.status(400).json({ error: "missing_APISPORTS_KEY" });
    }

    const date = String(req.query.date || "").trim();
    const from = String(req.query.from || "").trim();
    const to = String(req.query.to || "").trim();
    const country = String(req.query.country || "").trim();
    const q = String(req.query.q || "").trim();

    // Validación básica de fechas
    if (date && !isYMD(date)) {
      return res.status(400).json({ error: "invalid_date_format", expected: "YYYY-MM-DD" });
    }
    if (from && !isYMD(from)) {
      return res.status(400).json({ error: "invalid_from_format", expected: "YYYY-MM-DD" });
    }
    if (to && !isYMD(to)) {
      return res.status(400).json({ error: "invalid_to_format", expected: "YYYY-MM-DD" });
    }

    const host = process.env.APISPORTS_HOST || "v3.football.api-sports.io";
    const tz = process.env.APP_TZ || "America/Santiago";

    // Construye URL base
    const baseUrl = new URL(`https://${host}/fixtures`);
    baseUrl.searchParams.set("timezone", tz);

    // Estrategia:
    // 1) Si viene date -> un request.
    // 2) Si viene from/to:
    //    2.1) primero intentamos rango (from/to).
    //    2.2) si devuelve 0, hacemos fallback día a día (máx 10 días) para evitar quedar en 0.
    let upstreamTried = [];
    let finalResponse = [];
    let finalResults = 0;
    let usedFallback = false;

    const headers = apisportsHeaders();

    async function callUpstream(urlObj) {
      const urlStr = urlObj.toString();
      const { ok, status, data } = await fetchJsonWithTimeout(
        urlStr,
        { headers },
        9000
      );
      upstreamTried.push({ url: urlStr, ok, status, results: data?.results ?? null, errors: data?.errors ?? null });

      if (!ok) {
        return { ok, status, data };
      }
      const resp = Array.isArray(data?.response) ? data.response : [];
      return { ok: true, status, data, resp, results: data?.results ?? resp.length ?? 0 };
    }

    if (date) {
      const u = new URL(baseUrl.toString());
      u.searchParams.set("date", date);

      const r1 = await callUpstream(u);
      if (!r1.ok) {
        return res.status(r1.status || 500).json({
          error: "API_FOOTBALL_ERROR",
          status: r1.status,
          details: r1.data?.errors || r1.data?.message || r1.data || null,
          debug: { upstreamTried },
        });
      }

      finalResponse = r1.resp || [];
      finalResults = r1.results ?? (finalResponse.length || 0);
    } else if (from || to) {
      // Si solo viene from o solo to, igual lo intentamos (pero ideal ambos)
      const uRange = new URL(baseUrl.toString());
      if (from && to && from === to) {
        uRange.searchParams.set("date", from);
      } else {
        if (from) uRange.searchParams.set("from", from);
        if (to) uRange.searchParams.set("to", to);
      }

      const rRange = await callUpstream(uRange);
      if (!rRange.ok) {
        return res.status(rRange.status || 500).json({
          error: "API_FOOTBALL_ERROR",
          status: rRange.status,
          details: rRange.data?.errors || rRange.data?.message || rRange.data || null,
          debug: { upstreamTried },
        });
      }

      finalResponse = rRange.resp || [];
      finalResults = rRange.results ?? (finalResponse.length || 0);

      // Fallback si vino 0
      if (finalResults === 0 && from && to && from !== to) {
        const days = diffDays(from, to);
        const maxDays = 10; // límite seguro para no reventar runtime
        const span = Math.min(Math.max(days, 0), maxDays - 1);

        usedFallback = true;

        const byId = new Map();

        for (let i = 0; i <= span; i++) {
          const day = addDaysYMD(from, i);
          const uDay = new URL(baseUrl.toString());
          uDay.searchParams.set("date", day);

          const rDay = await callUpstream(uDay);
          if (rDay.ok && Array.isArray(rDay.resp)) {
            for (const it of rDay.resp) {
              const id = it?.fixture?.id;
              if (id != null && !byId.has(id)) byId.set(id, it);
            }
          }
        }

        finalResponse = Array.from(byId.values());
        finalResults = finalResponse.length;
      }
    } else {
      return res.status(400).json({
        error: "missing_query",
        example: "/api/fixtures?date=2025-12-20 OR /api/fixtures?from=2025-12-20&to=2025-12-21",
      });
    }

    // Aplica filtros opcionales en nuestro lado (country / q)
    let filtered = finalResponse;

    if (country) {
      const cNorm = country.toLowerCase();
      filtered = filtered.filter((it) => String(it?.league?.country || "").toLowerCase().includes(cNorm));
    }

    if (q) {
      const qNorm = q.toLowerCase();
      filtered = filtered.filter((it) => {
        const text = [
          it?.league?.name,
          it?.league?.country,
          it?.teams?.home?.name,
          it?.teams?.away?.name,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return text.includes(qNorm);
      });
    }

    // Normalizamos a items también (para que tu frontend pueda usar data.items si quiere)
    const items = normalizeFixtureItems(filtered);

    // Cache cortita (Vercel)
    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=30");

    return res.status(200).json({
      query: {
        date: date || null,
        from: from || null,
        to: to || null,
        country: country || null,
        q: q || null,
        tz,
      },
      results: items.length,
      usedFallback,
      response: filtered, // raw API-Football-ish
      items, // normalizado
      debug: {
        upstreamTried,
      },
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
      { headers: apisportsHeaders() },
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
