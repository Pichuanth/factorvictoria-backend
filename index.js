// backend/index.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

// --- pagos & regalos
const Flow = require("./payments/flow.js");
const MP = require("./payments/mercadopago.js");
const Shopify = require("./vendors/shopify.js");
const flow = Flow(process.env);
const mp = MP(process.env);
const shopify = Shopify(process.env);

const app = express();
app.use(cors());
app.use(express.json());

// Para webhooks que necesitan raw body
app.use("/api/pay/webhook", express.raw({ type: "*/*" }));
app.use("/api/pay/mp/webhook", express.raw({ type: "*/*" }));
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "factorvictoria-backend",
    time: new Date().toISOString(),
    tz: process.env.APP_TZ || "not-set",
  });
});

// ===== Postgres =====
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ===== Boot: esquemas/tablas y seed =====
(async () => {
  // esquema base + fixtures
  await pool.query(`CREATE SCHEMA IF NOT EXISTS app;`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app.fixtures (
      id      text PRIMARY KEY,
      date    timestamptz NOT NULL,
      status  text,
      league  text,
      country text,
      home    text,
      away    text,
      venue   text,
      tv      text
    );
  `);

  // usuarios
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app.users (
      id serial PRIMARY KEY,
      email text UNIQUE NOT NULL,
      name text, phone text,
      address1 text, address2 text,
      city text, region text, zip text, country text default 'CL',
      created_at timestamptz default now()
    );
  `);

  // membresías (planes)  — months ahora puede ser NULL (para vitalicio)
await pool.query(`
  CREATE TABLE IF NOT EXISTS app.memberships (
    id text PRIMARY KEY,
    name text NOT NULL,
    months integer,                 -- <— sin NOT NULL
    price_clp integer NOT NULL,
    gift_sku text
  );
`);
// Si la tabla ya existía con NOT NULL, quitamos la restricción por si acaso:
await pool.query(`ALTER TABLE app.memberships ALTER COLUMN months DROP NOT NULL;`).catch(()=>{});


  // órdenes
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app.orders (
      id bigserial PRIMARY KEY,
      user_id integer NOT NULL REFERENCES app.users(id),
      membership_id text NOT NULL REFERENCES app.memberships(id),
      amount_clp integer NOT NULL,
      provider text NOT NULL,            -- 'flow' | 'mp'
      provider_id text,                  -- id de preferencia/token
      status text NOT NULL default 'pending',  -- pending | paid | failed | canceled
      created_at timestamptz default now(),
      paid_at timestamptz
    );
  `);

  // suscripciones activas
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app.subscriptions (
      id bigserial PRIMARY KEY,
      user_id integer NOT NULL REFERENCES app.users(id),
      membership_id text NOT NULL REFERENCES app.memberships(id),
      starts_at timestamptz NOT NULL,
      ends_at timestamptz,
      active boolean NOT NULL default true,
      created_at timestamptz default now()
    );
  `);

  // seed de planes (sin regalos, con vitalicio)
await pool.query(`
  INSERT INTO app.memberships (id,name,months,price_clp,gift_sku) VALUES
    ('monthly','Mensual',1,19990,NULL),
    ('quarter','3 meses',3,44990,NULL),
    ('annual','Anual',12,99990,NULL),
    ('lifetime','Vitalicio',NULL,249990,NULL)
  ON CONFLICT (id) DO UPDATE
    SET name=EXCLUDED.name,
        months=EXCLUDED.months,
        price_clp=EXCLUDED.price_clp,
        gift_sku=EXCLUDED.gift_sku;
`);

})().catch((err) => console.error("BOOT ERROR:", err));

// ===== Health =====
app.get("/api/health", (_req, res) => res.json({ ok: true }));

// ---------- helpers fixtures ----------
function mapResponse(data) {
  return (data.response || []).map((f) => ({
    fixture: {
      id: f.fixture?.id,
      date: f.fixture?.date,
      timestamp: f.fixture?.timestamp,
      status: f.fixture?.status?.short ?? null,
    },
    league: {
      id: f.league?.id ?? null,
      name: f.league?.name ?? null,
      country: f.league?.country ?? null,
    },
    teams: {
      home: { id: f.teams?.home?.id ?? null, name: f.teams?.home?.name ?? null },
      away: { id: f.teams?.away?.id ?? null, name: f.teams?.away?.name ?? null },
    },
    venue: { name: f.fixture?.venue?.name ?? null },
  }));
}

function includesCI(haystack, needle) {
  return String(haystack || "").toLowerCase().includes(String(needle || "").toLowerCase());
}

function filterByCountryAndQ(fixtures, country, q) {
  let out = fixtures;

  if (country) {
    out = out.filter((fx) => includesCI(fx.league?.country, country));
  }

  if (q) {
    out = out.filter((fx) => {
      const blob = [
        fx.league?.name,
        fx.league?.country,
        fx.teams?.home?.name,
        fx.teams?.away?.name,
      ].join(" ");
      return includesCI(blob, q);
    });
  }

  return out;
}

async function fetchFromApi({ from, to, tz }) {
  const host = process.env.APISPORTS_HOST || "v3.football.api-sports.io";
  const url = new URL(`https://${host}/fixtures`);

  // API-Football soporta rangos por from/to (YYYY-MM-DD)
  url.searchParams.set("from", from);
  url.searchParams.set("to", to);
  url.searchParams.set("timezone", tz);

  // opcional: solo próximos (NS). Si quieres ver también LIVE/FT, comenta esta línea.
  url.searchParams.set("status", "NS");

  const r = await fetch(url, {
    headers: { "x-apisports-key": process.env.APISPORTS_KEY },
  });

  const data = await r.json().catch(() => ({}));
  if (!r.ok) return { error: "upstream_error", status: r.status, data };
  if (data?.errors?.token) return { error: "bad_apikey", status: 401, data: data.errors };
  return { data };
}

// ===== FIXTURES (soporta date o rango from/to) =====
app.get("/api/fixtures", async (req, res, next) => {
  try {
    const TZ = process.env.APP_TZ || "America/Santiago";

    const from = String(req.query.from || "").trim(); // YYYY-MM-DD
    const to = String(req.query.to || "").trim();     // YYYY-MM-DD
    const date = String(req.query.date || "").trim(); // YYYY-MM-DD

    const league = String(req.query.league || "").trim();
    const team = String(req.query.team || "").trim();

    // Si viene rango, úsalo. Si no, usa date. Si no viene nada, usa hoy.
    const today = new Date().toISOString().slice(0, 10);
    const qFrom = from || date || today;
    const qTo = to || date || qFrom;

    if (process.env.APISPORTS_KEY) {
      const host = process.env.APISPORTS_HOST || "v3.football.api-sports.io";
      const url = new URL(`https://${host}/fixtures`);

      // API-Football soporta from/to (rango) + timezone
      url.searchParams.set("from", qFrom);
      url.searchParams.set("to", qTo);
      url.searchParams.set("timezone", tz);

      if (league) url.searchParams.set("league", league);
      if (team) url.searchParams.set("team", team);

      const r = await fetch(url, {
        headers: { "x-apisports-key": process.env.APISPORTS_KEY },
      });

      const data = await r.json().catch(() => ({}));
      if (!r.ok) return res.status(r.status).json({ error: "upstream_error", details: data });
      if (data?.errors?.token) return res.status(401).json({ error: "bad_apikey", details: data.errors });

      return res.json({
        source: "api",
        from: qFrom,
        to: qTo,
        fixtures: mapResponse(data),
      });
    }

    // Fallback DB: por ahora filtra solo por rango (date::date entre from y to)
    const { rows } = await pool.query(
      `SELECT id, date, status, league, country, home, away, venue, tv
         FROM app.fixtures
        WHERE date::date BETWEEN $1::date AND $2::date
        ORDER BY date ASC`,
      [qFrom, qTo]
    );

    res.json({ source: "db", from: qFrom, to: qTo, fixtures: rows });
  } catch (e) {
    next(e);
  }
});
// ===== ODDS (1X2 + Over/Under 2.5) =====
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

    // Tomamos el primer bookmaker disponible con mercados útiles
    const bookmakers = responses[0]?.bookmakers || [];

    let best1x2 = null;   // {home, draw, away, bookmaker}
    let bestOU25 = null;  // {over, under, bookmaker}

    for (const b of bookmakers) {
      const bookmakerName = b?.bookmaker?.name || "Unknown";

      const bets = b?.bets || [];

      // 1X2 suele venir como "Match Winner"
      const mw = bets.find(x => (x?.name || "").toLowerCase().includes("match winner"));
      if (mw?.values?.length) {
        const home = mw.values.find(v => (v?.value || "").toLowerCase() === "home")?.odd;
        const draw = mw.values.find(v => (v?.value || "").toLowerCase() === "draw")?.odd;
        const away = mw.values.find(v => (v?.value || "").toLowerCase() === "away")?.odd;

        if (home && draw && away && !best1x2) {
          best1x2 = { home: Number(home), draw: Number(draw), away: Number(away), bookmaker: bookmakerName };
        }
      }

      // Over/Under suele venir como "Goals Over/Under"
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
      markets: {
        "1X2": best1x2,
        "OU_2_5": bestOU25,
      },
      raw_bookmakers: bookmakers.length,
    });
  } catch (e) {
    next(e);
  }
});
