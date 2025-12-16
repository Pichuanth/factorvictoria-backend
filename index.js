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

// ===== FIXTURES =====
// Soporta:
// - /api/fixtures?from=YYYY-MM-DD&to=YYYY-MM-DD&country=Chile&q=colo
// - /api/fixtures?date=YYYY-MM-DD (compatibilidad)
app.get("/api/fixtures", async (req, res, next) => {
  try {
    const tz = process.env.TZ || "UTC";

    const dateParam = String(req.query.date || "").trim();
    const from = String(req.query.from || "").trim();
    const to = String(req.query.to || "").trim();

    // country/q vienen desde Comparator.jsx
    const country = String(req.query.country || "").trim();
    const q = String(req.query.q || "").trim();

    // compatibilidad: si viene date, lo convertimos a from/to
    const finalFrom = dateParam || from || new Date().toISOString().slice(0, 10);
    const finalTo = dateParam || to || finalFrom;

    if (process.env.APISPORTS_KEY) {
      const { data, error, status } = await fetchFromApi({ from: finalFrom, to: finalTo, tz });
      if (error) return res.status(status || 500).json({ error, details: data });

      const fixtures = filterByCountryAndQ(mapResponse(data), country, q);
      return res.json({ source: "api", from: finalFrom, to: finalTo, fixtures });
    }

    // Fallback DB (si no hay APISPORTS_KEY)
    const { rows } = await pool.query(
      `
      SELECT id, date, status, league, country, home, away, venue, tv
        FROM app.fixtures
       WHERE date::date >= $1::date
         AND date::date <= $2::date
       ORDER BY date ASC
      `,
      [finalFrom, finalTo]
    );

    const fixtures = filterByCountryAndQ(
      rows.map((r) => ({
        fixture: { id: r.id, date: r.date, timestamp: null, status: r.status },
        league: { id: null, name: r.league, country: r.country },
        teams: { home: { id: null, name: r.home }, away: { id: null, name: r.away } },
        venue: { name: r.venue },
      })),
      country,
      q
    );

    res.json({ source: "db", from: finalFrom, to: finalTo, fixtures });
  } catch (e) {
    next(e);
  }
});
