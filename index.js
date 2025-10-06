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
    id: String(f.fixture?.id),
    date: f.fixture?.date,
    status: f.fixture?.status?.short ?? null,
    league: f.league?.name ?? null,
    country: f.league?.country ?? null,
    home: f.teams?.home?.name ?? null,
    away: f.teams?.away?.name ?? null,
    venue: f.fixture?.venue?.name ?? null,
    tv: null,
  }));
}

async function fetchFromApi({ date, league, team, tz }) {
  const host = process.env.APISPORTS_HOST || "v3.football.api-sports.io";
  const url = new URL(`https://${host}/fixtures`);
  url.searchParams.set("date", date);
  url.searchParams.set("timezone", tz);
  if (league) url.searchParams.set("league", league);
  if (team) url.searchParams.set("team", team);

  const r = await fetch(url, { headers: { "x-apisports-key": process.env.APISPORTS_KEY } });
  const data = await r.json().catch(() => ({}));

  if (!r.ok) return { error: "upstream_error", status: r.status, data };
  if (data?.errors?.token) return { error: "bad_apikey", status: 401, data: data.errors };
  return { data };
}

// ===== FIXTURES =====
app.get("/api/fixtures", async (req, res, next) => {
  try {
    const date = String(req.query.date || new Date().toISOString().slice(0, 10));
    const league = String(req.query.league || "").trim();
    const team = String(req.query.team || "").trim();
    const tz = process.env.TZ || "UTC";

    if (process.env.APISPORTS_KEY) {
      const { data, error, status } = await fetchFromApi({ date, league, team, tz });
      if (error) return res.status(status || 500).json({ error, details: data });
      return res.json({ source: "api", date, fixtures: mapResponse(data) });
    }

    const { rows } = await pool.query(
      `SELECT id, date, status, league, country, home, away, venue, tv
         FROM app.fixtures
        WHERE date::date = $1::date
        ORDER BY date ASC`,
      [date]
    );
    res.json({ source: "db", date, fixtures: rows });
  } catch (e) {
    next(e);
  }
});

// ===== ADMIN sync fixtures =====
app.get("/admin/fixtures/sync", async (req, res, next) => {
  try {
    const token = req.headers["x-admin-token"] || req.query.token;
    if (token !== process.env.ADMIN_TOKEN) return res.status(401).json({ error: "unauthorized" });
    if (!process.env.APISPORTS_KEY) return res.status(400).json({ error: "missing APISPORTS_KEY" });

    const date = String(req.query.date || new Date().toISOString().slice(0, 10));
    const league = String(req.query.league || "").trim();
    const team = String(req.query.team || "").trim();
    const tz = process.env.TZ || "UTC";

    const { data, error, status } = await fetchFromApi({ date, league, team, tz });
    if (error) return res.status(status || 500).json({ error, details: data });

    const items = mapResponse(data);
    if (!items.length) return res.json({ ok: true, saved: 0, date, note: "no fixtures returned" });

    const params = [];
    const values = items.map((it, idx) => {
      const base = idx * 9;
      params.push(it.id, it.date, it.status, it.league, it.country, it.home, it.away, it.venue, it.tv);
      return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9})`;
    });

    await pool.query(
      `
      INSERT INTO app.fixtures (id, date, status, league, country, home, away, venue, tv)
      VALUES ${values.join(",")}
      ON CONFLICT (id) DO UPDATE SET
        date=EXCLUDED.date, status=EXCLUDED.status, league=EXCLUDED.league,
        country=EXCLUDED.country, home=EXCLUDED.home, away=EXCLUDED.away,
        venue=EXCLUDED.venue, tv=EXCLUDED.tv
    `,
      params
    );

    res.json({ ok: true, saved: items.length, date });
  } catch (e) {
    next(e);
  }
});

// ---------- helpers pagos ----------
async function upsertUser(client, u) {
  const q = `
    INSERT INTO app.users (email,name,phone,address1,address2,city,region,zip,country)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    ON CONFLICT (email) DO UPDATE SET
      name=EXCLUDED.name, phone=EXCLUDED.phone,
      address1=EXCLUDED.address1, address2=EXCLUDED.address2,
      city=EXCLUDED.city, region=EXCLUDED.region, zip=EXCLUDED.zip, country=EXCLUDED.country
    RETURNING *`;
  const { rows } = await client.query(q, [
    u.email,
    u.name || null,
    u.phone || null,
    u.address1 || null,
    u.address2 || null,
    u.city || null,
    u.region || null,
    u.zip || null,
    u.country || "CL",
  ]);
  return rows[0];
}

// ===== CHECKOUT (Flow o MP) =====
app.post("/api/pay/checkout", async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { planId, email, name, phone, shipping, provider } = req.body || {};
    if (!planId || !email) return res.status(400).json({ error: "missing_fields" });

    const m = await client.query("SELECT * FROM app.memberships WHERE id=$1", [planId]);
    if (!m.rowCount) return res.status(400).json({ error: "invalid_plan" });
    const mem = m.rows[0];

    const user = await upsertUser(client, {
      email,
      name,
      phone,
      address1: shipping?.address1,
      address2: shipping?.address2,
      city: shipping?.city,
      region: shipping?.region,
      zip: shipping?.zip,
      country: "CL",
    });

    const prov = (provider || "flow").toLowerCase();
    const o = await client.query(
      `INSERT INTO app.orders (user_id, membership_id, amount_clp, provider, status)
       VALUES ($1,$2,$3,$4,'pending') RETURNING *`,
      [user.id, mem.id, mem.price_clp, prov]
    );
    const order = o.rows[0];

    const gateway = prov === "mp" ? mp : flow;
    const { providerId, redirectUrl } = await gateway.createPayment({
      orderId: String(order.id),
      amount: mem.price_clp,
      email,
      concept: mem.name,
      returnUrl: process.env.FLOW_RETURN_URL, // usamos misma URL
      webhookUrl: prov === "mp" ? process.env.MP_WEBHOOK_URL : process.env.FLOW_WEBHOOK_URL,
    });

    await client.query(`UPDATE app.orders SET provider_id=$1 WHERE id=$2`, [providerId, order.id]);

    return res.json({ ok: true, redirectUrl });
  } catch (e) {
    next(e);
  } finally {
    client.release();
  }
});

// ===== Webhook FLOW =====
app.post("/api/pay/webhook", async (req, res, next) => {
  try {
    const ok = flow.verifyWebhook(req.body, req.headers);
    if (!ok) return res.status(400).send("bad signature");

    const body = JSON.parse(req.body.toString());
    const providerId = body?.paymentId || body?.token || body?.id;
    const orderId = body?.commerceOrder || body?.orderId || body?.metadata?.orderId;
    const status = body?.status; // 2/aprobado o "paid" según tu Flow

    if (!orderId) return res.status(400).send("missing orderId");

    if (status === "paid" || status === 2 || status === "approved") {
      // marcar orden pagada
      await pool.query(`UPDATE app.orders SET status='paid', paid_at=now() WHERE id=$1`, [orderId]);

      // activar suscripción (vitalicio => ends_at NULL)
      await pool.query(
        `INSERT INTO app.subscriptions (user_id, membership_id, starts_at, ends_at, active)
         SELECT user_id,
                membership_id,
                CURRENT_DATE,
                CASE WHEN m.months IS NULL
                     THEN NULL
                     ELSE CURRENT_DATE + (m.months || ' months')::interval
                END,
                true
           FROM app.orders o
           JOIN app.memberships m ON m.id = o.membership_id
          WHERE o.id = $1`,
        [orderId]
      );

      // Regalo en Shopify (si configurado)
      if (process.env.SHOPIFY_TOKEN) {
        const orderRow = (
          await pool.query(
            `SELECT o.id, o.membership_id, u.email, u.name, u.phone, u.address1, u.address2, u.city, u.region, u.zip
               FROM app.orders o JOIN app.users u ON u.id=o.user_id
              WHERE o.id=$1`,
            [orderId]
          )
        ).rows[0];

        const giftSku = (
          await pool.query(`SELECT gift_sku FROM app.memberships WHERE id=$1`, [orderRow.membership_id])
        ).rows[0]?.gift_sku;

        if (giftSku) {
          await shopify.createDraftOrder({
            email: orderRow.email,
            shipping: {
              name: orderRow.name,
              phone: orderRow.phone,
              address1: orderRow.address1,
              address2: orderRow.address2,
              city: orderRow.city,
              region: orderRow.region,
              zip: orderRow.zip,
            },
            lineItems: [{ title: "Regalo Membresía", sku: giftSku, qty: 1 }],
          });
        }
      }
    } else if (status === "failed" || status === "canceled") {
      await pool.query(`UPDATE app.orders SET status=$2 WHERE id=$1`, [orderId, "failed"]);
    }

    res.send("OK");
  } catch (e) {
    next(e);
  }
});

// ===== Webhook MERCADO PAGO =====
app.post("/api/pay/mp/webhook", async (req, res, next) => {
  try {
    const body = JSON.parse(req.body.toString());
    const orderId = body?.data?.id || body?.metadata?.orderId || body?.order?.id;
    const status = body?.status || body?.action; // ajusta a tu formato final

    if (orderId && (status === "approved" || status === "payment.created")) {
      // marcar orden pagada
      await pool.query(`UPDATE app.orders SET status='paid', paid_at=now() WHERE id=$1`, [orderId]);

      // activar suscripción (vitalicio => ends_at NULL)
      await pool.query(
        `INSERT INTO app.subscriptions (user_id, membership_id, starts_at, ends_at, active)
         SELECT user_id,
                membership_id,
                CURRENT_DATE,
                CASE WHEN m.months IS NULL
                     THEN NULL
                     ELSE CURRENT_DATE + (m.months || ' months')::interval
                END,
                true
           FROM app.orders o
           JOIN app.memberships m ON m.id = o.membership_id
          WHERE o.id = $1`,
        [orderId]
      );
    }

    res.send("OK");
  } catch (e) {
    next(e);
  }
});

// ===== Admin: otorgar membresía manual (escribe en DB) =====
app.post("/admin/memberships/grant", async (req, res) => {
  const token = req.headers["x-admin-token"];
  if (token !== process.env.ADMIN_TOKEN) return res.status(401).json({ error: "unauthorized" });

  const { email, plan = "lifetime", name, phone } = req.body || {};
  if (!email) return res.status(400).json({ error: "missing_email" });

  const client = await pool.connect();
  try {
    // 1) upsert usuario
    const u = await client.query(
      `INSERT INTO app.users (email,name,phone)
       VALUES ($1,$2,$3)
       ON CONFLICT (email) DO UPDATE
         SET name=COALESCE(app.users.name,$2),
             phone=COALESCE(app.users.phone,$3)
       RETURNING *`,
      [email, name || null, phone || null]
    );

    // 2) plan válido
    const m = await client.query(`SELECT * FROM app.memberships WHERE id=$1`, [plan]);
    if (!m.rowCount) return res.status(400).json({ error: "invalid_plan" });
    const mem = m.rows[0];

    // 3) “orden” pagada (admin)
    const o = await client.query(
      `INSERT INTO app.orders (user_id, membership_id, amount_clp, provider, provider_id, status, paid_at)
       VALUES ($1,$2,$3,'admin','manual','paid', now())
       RETURNING *`,
      [u.rows[0].id, mem.id, mem.price_clp]
    );

    // 4) activar suscripción (vitalicio => ends_at NULL)
    await client.query(
      `INSERT INTO app.subscriptions (user_id, membership_id, starts_at, ends_at, active)
       VALUES ($1,$2,CURRENT_DATE,
               CASE WHEN $3::int IS NULL THEN NULL
                    ELSE CURRENT_DATE + ($3 || ' months')::interval END,
               true)`,
      [u.rows[0].id, mem.id, mem.months]
    );

    return res.json({ ok: true, email, plan, orderId: o.rows[0].id });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "db_error" });
  } finally {
    client.release();
  }
});

// --- debug: ver últimas órdenes
app.get("/api/orders", async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const { rows } = await pool.query(
      `SELECT id, user_id, membership_id, amount_clp, provider, provider_id, status, created_at, paid_at
         FROM app.orders
        ORDER BY id DESC
        LIMIT $1`,
      [limit]
    );
    res.json(rows);
  } catch (e) { next(e); }
});

// --- debug: ver suscripciones
app.get("/api/subscriptions", async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const { rows } = await pool.query(
      `SELECT id, user_id, membership_id, starts_at, ends_at, active, created_at
         FROM app.subscriptions
        ORDER BY id DESC
        LIMIT $1`,
      [limit]
    );
    res.json(rows);
  } catch (e) { next(e); }
});

// --- admin ping (debug)
app.get("/admin/ping", (_req, res) => res.json({ ok: true }));

// ===== 404 & error handler =====
app.use((req, res) => res.status(404).json({ error: "Not found" }));
app.use((err, _req, res, _next) => {
  console.error("ERROR:", err);
  res.status(500).json({ error: "server_error" });
});

// ===== Listen =====
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`API running on http://localhost:${PORT}`));
