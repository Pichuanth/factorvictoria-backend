// app.js (CommonJS)
const express = require("express");
const cors = require("cors");
const pg = require("pg");

const { Pool } = pg;
const app = express();

const ALLOWED_ORIGINS = [
  "https://factorvictoria.com",
  "https://www.factorvictoria.com",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
];

const corsOptions = {
  origin: function (origin, cb) {
    // permite requests sin origin (Postman / server-to-server)
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error("Not allowed by CORS: " + origin));
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "x-admin-token"],
  credentials: false,
};

app.use(
  cors({
    origin: function (origin, callback) {
      // Permite requests sin origin (Postman / server-to-server)
      if (!origin) return callback(null, true);

      if (ALLOWED_ORIGINS.includes(origin)) {
        return callback(null, true);
      }

      return callback(new Error("Not allowed by CORS: " + origin));
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-admin-token"],
    credentials: false,
  })
);

// ✅ ESTE es el middleware correcto (con tus options)
app.use(cors(corsOptions));

// 🔑 MUY IMPORTANTE PARA EL PREFLIGHT (OPTIONS)
app.options("*", cors(corsOptions));

// (3) JSON después de CORS
app.use(express.json());
app.use("/api", oddsRouter);

// (4) RUTAS: asegúrate que el router esté definido ANTES de usarlo
const oddsRouter = require("./routes/odds");
app.use("/api", oddsRouter);

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

function apisportsHeaders() {
  const API_KEY = process.env.APISPORTS_KEY;
  const API_HOST = process.env.APISPORTS_HOST || "v3.football.api-sports.io";
  return {
    "x-apisports-key": API_KEY,
    "x-rapidapi-key": API_KEY,
    "x-rapidapi-host": API_HOST,
  };
}

// Fetch con timeout (evita 504)
async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 9000) {
  if (typeof fetch !== "function") {
    // Si esto pasa, tu runtime no es Node 18+ en Vercel
    return {
      ok: false,
      status: 500,
      data: { error: "fetch_not_available", hint: "Configura Node.js 18+ en Vercel (Project Settings -> General -> Node.js Version)." },
    };
  }

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

function normalizeFixtureItems(responseArray) {
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
        home: teams.home ? { id: teams.home.id, name: teams.home.name, logo: teams.home.logo } : null,
        away: teams.away ? { id: teams.away.id, name: teams.away.name, logo: teams.away.logo } : null,
      },
      goals: {
        home: goals.home,
        away: goals.away,
      },
    };
  });
}

function normStr(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
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
    hasFetch: typeof fetch === "function",
    now: new Date().toISOString(),
  });
});

// ---------- FIXTURES ----------
app.get("/api/fixtures", async (req, res) => {
  try {

    const date = String(req.query.date || "").trim();
    const from = String(req.query.from || "").trim();
    const to = String(req.query.to || "").trim();
    const country = String(req.query.country || "").trim();
    const q = String(req.query.q || "").trim();

    if (date && !isYMD(date)) return res.status(400).json({ error: "invalid_date_format", expected: "YYYY-MM-DD" });
    if (from && !isYMD(from)) return res.status(400).json({ error: "invalid_from_format", expected: "YYYY-MM-DD" });
    if (to && !isYMD(to)) return res.status(400).json({ error: "invalid_to_format", expected: "YYYY-MM-DD" });

    const host = process.env.APISPORTS_HOST || "v3.football.api-sports.io";
    const tz = process.env.APP_TZ || "America/Santiago";

    const baseUrl = new URL(`https://${host}/fixtures`);
    baseUrl.searchParams.set("timezone", tz);

    let upstreamTried = [];
    let finalResponse = [];
    let finalResults = 0;
    let usedFallback = false;

    const headers = apisportsHeaders();

    async function callUpstream(urlObj) {
      const urlStr = urlObj.toString();
      const { ok, status, data } = await fetchJsonWithTimeout(urlStr, { headers }, 9000);

      upstreamTried.push({
        url: urlStr,
        ok,
        status,
        results: data?.results ?? null,
        errors: data?.errors ?? null,
      });

      if (!ok) return { ok, status, data };

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
      finalResults = r1.results ?? finalResponse.length;
    } else if (from || to) {
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
      finalResults = rRange.results ?? finalResponse.length;

      if (finalResults === 0 && from && to && from !== to) {
        const days = diffDays(from, to);
        const maxDays = 10;
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

    let filtered = finalResponse;

    if (country) {
      const cNorm = country.toLowerCase();
      filtered = filtered.filter((it) => String(it?.league?.country || "").toLowerCase().includes(cNorm));
    }

    if (q) {
      const qNorm = q.toLowerCase();
      filtered = filtered.filter((it) => {
        const text = [it?.league?.name, it?.league?.country, it?.teams?.home?.name, it?.teams?.away?.name]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return text.includes(qNorm);
      });
    }

    const items = normalizeFixtureItems(filtered);

    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=30");

    return res.status(200).json({
      query: { date: date || null, from: from || null, to: to || null, country: country || null, q: q || null, tz },
      results: items.length,
      usedFallback,
      response: filtered,
      items,
      debug: { upstreamTried },
    });
  } catch (e) {
    if (String(e?.name) === "AbortError") {
      return res.status(504).json({ error: "apisports_timeout", message: "API-FOOTBALL no respondió a tiempo (timeout). Intenta nuevamente." });
    }
    return res.status(500).json({ error: "server_error", message: e?.message || String(e) });
  }
});
// ---------- FIXTURE STATISTICS ----------
app.get("/api/fixture/:id/statistics", async (req, res) => {
  try {
    if (!process.env.APISPORTS_KEY) return res.status(400).json({ error: "missing_APISPORTS_KEY" });

    const { id } = req.params;
    if (!id) return res.status(400).json({ error: "missing_fixture_id" });

    const url = new URL(`${apiSportsBase()}/fixtures/statistics`);
    url.searchParams.set("fixture", id);

    const { ok, status, data } = await fetchJsonWithTimeout(
      url.toString(),
      { headers: apisportsHeaders() },
      8000
    );

    if (!ok) {
      return res.status(status || 500).json({
        error: "upstream_error",
        status,
        details: data,
      });
    }

    return res.json(data);
  } catch (e) {
    if (String(e?.name) === "AbortError") {
      return res.status(504).json({ error: "apisports_timeout", message: "API-FOOTBALL no respondió a tiempo (timeout)." });
    }
    return res.status(500).json({ error: "server_error", message: e?.message || String(e) });
  }
});

// ---------- ODDS ----------
app.get("/api/odds", async (req, res) => {
  try {
    if (!process.env.APISPORTS_KEY) return res.status(400).json({ error: "missing_APISPORTS_KEY" });

    const fixture = String(req.query.fixture || "").trim();
    if (!fixture) return res.status(400).json({ error: "missing_fixture" });
    if (!/^\d+$/.test(fixture)) return res.status(400).json({ error: "fixture_must_be_numeric_id" });

    const url = new URL(`${apiSportsBase()}/odds`);
    url.searchParams.set("fixture", fixture);

    const { ok, status, data } = await fetchJsonWithTimeout(url.toString(), { headers: apisportsHeaders() }, 8000);

    if (!ok) return res.status(status).json({ error: "upstream_error", status, details: data });

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
      return res.status(504).json({ error: "apisports_timeout", message: "API-FOOTBALL no respondió a tiempo (timeout). Intenta nuevamente." });
    }
    return res.status(500).json({ error: "server_error", message: e?.message || String(e) });
  }
});

// ---------- REFEREES (Tarjeteros MVP) ----------
// GET /api/referees/cards?from=YYYY-MM-DD&to=YYYY-MM-DD&country=Italy (country opcional)
const TOP_REFEREES = [
  { name: "Anthony Taylor", avgCards: 4.6, leagues: ["England"] },
  { name: "Michael Oliver", avgCards: 4.2, leagues: ["England"] },
  { name: "Daniele Orsato", avgCards: 4.8, leagues: ["Italy"] },
  { name: "Marco Guida", avgCards: 5.1, leagues: ["Italy"] },
  { name: "José María Sánchez", avgCards: 5.4, leagues: ["Spain"] },
  { name: "Mateu Lahoz", avgCards: 5.8, leagues: ["Spain"] },
  { name: "Clément Turpin", avgCards: 4.3, leagues: ["France"] },
  { name: "Benoît Bastien", avgCards: 4.9, leagues: ["France"] },
  { name: "Felix Zwayer", avgCards: 5.2, leagues: ["Germany"] },
  { name: "Daniel Siebert", avgCards: 4.7, leagues: ["Germany"] },
];

app.get("/api/referees/cards", async (req, res) => {
  try {
    if (!process.env.APISPORTS_KEY) return res.status(400).json({ error: "missing_APISPORTS_KEY" });

    const from = String(req.query.from || "").trim();
    const to = String(req.query.to || "").trim();
    const country = String(req.query.country || "").trim(); // opcional

    if (!from || !to) {
      return res.status(400).json({
        error: "missing_from_to",
        example: "/api/referees/cards?from=2025-12-26&to=2025-12-28",
      });
    }
    if (!isYMD(from) || !isYMD(to)) {
      return res.status(400).json({ error: "invalid_date_format", expected: "YYYY-MM-DD" });
    }

    // 1 llamada: fixtures del rango
    const host = process.env.APISPORTS_HOST || "v3.football.api-sports.io";
    const tz = process.env.APP_TZ || "America/Santiago";
    const url = new URL(`https://${host}/fixtures`);
    url.searchParams.set("from", from);
    url.searchParams.set("to", to);
    url.searchParams.set("timezone", tz);

    const { ok, status, data } = await fetchJsonWithTimeout(url.toString(), { headers: apisportsHeaders() }, 9000);

    if (!ok) {
      return res.status(status || 500).json({
        error: "upstream_error",
        status,
        details: data,
      });
    }

    let response = Array.isArray(data?.response) ? data.response : [];

    // filtro local por country (league.country)
    if (country) {
      const cNorm = normStr(country);
      response = response.filter((it) => normStr(it?.league?.country).includes(cNorm));
    }

    // Buscamos un partido donde el referee asignado coincida con alguno del TOP
    const topNorm = TOP_REFEREES.map((r) => ({ ...r, key: normStr(r.name) }));

    const pick = response.find((it) => {
      const ref = normStr(it?.fixture?.referee);
      if (!ref) return false;
      return topNorm.some((r) => ref.includes(r.key));
    });

    let recommended = null;
    if (pick) {
      const refRaw = String(pick?.fixture?.referee || "").trim();
      const refMeta = topNorm.find((r) => normStr(refRaw).includes(r.key)) || null;

      recommended = {
        referee: { name: refMeta?.name || refRaw, avgCards: refMeta?.avgCards ?? null },
        fixture: {
          id: pick?.fixture?.id,
          date: pick?.fixture?.date,
          timestamp: pick?.fixture?.timestamp,
          league: { id: pick?.league?.id, name: pick?.league?.name, country: pick?.league?.country },
          teams: {
            home: { id: pick?.teams?.home?.id, name: pick?.teams?.home?.name, logo: pick?.teams?.home?.logo },
            away: { id: pick?.teams?.away?.id, name: pick?.teams?.away?.name, logo: pick?.teams?.away?.logo },
          },
        },
      };
    }

    res.setHeader("Cache-Control", "s-maxage=120, stale-while-revalidate=60");

    return res.json({
      query: { from, to, country: country || null, tz },
      topReferees: TOP_REFEREES,
      recommended,
      message: recommended
        ? "OK"
        : "Aún no se ha asignado un partido con árbitro top en este rango. Prueba ampliando fechas o quitando el filtro país.",
      fixturesScanned: response.length,
    });
  } catch (e) {
    if (String(e?.name) === "AbortError") {
      return res.status(504).json({ error: "apisports_timeout", message: "Timeout consultando API-FOOTBALL." });
    }
    return res.status(500).json({ error: "server_error", message: e?.message || String(e) });
  }
});

module.exports = app;
