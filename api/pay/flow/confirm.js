const cors = require("../../_cors");
const db = require("../../_db");
const qs = require("querystring");
const plans = require("../../_plans");
const { flowPost } = require("./_flow");

async function ensureMembershipsTable() {
  // Idempotente: si ya existe, no hace nada.
  // Si tu tabla ya existe con otro schema, Postgres ignorará este CREATE TABLE.
  await db.query(`
    create table if not exists memberships (
      email text primary key,
      plan_id text,
      tier text,
      status text,
      start_at timestamptz,
      end_at timestamptz,
      cancel_at_period_end boolean default false,
      updated_at timestamptz default now()
    )
  `);
}

async function upsertMembership({ email, planId, tier, status, endAt }) {
  try {
    await db.query(
      `insert into memberships (email, plan_id, tier, status, start_at, end_at, updated_at)
       values (lower($1), $2, $3, $4, now(), $5, now())
       on conflict (email) do update set
         plan_id = excluded.plan_id,
         tier = excluded.tier,
         status = excluded.status,
         start_at = excluded.start_at,
         end_at = excluded.end_at,
         updated_at = now()`,
      [email, planId, tier, status, endAt]
    );
    return;
  } catch (e) {
    // Fallback si no existe constraint compatible en tu tabla actual
    await db.query(
      `update memberships
       set plan_id=$2, tier=$3, status=$4, start_at=now(), end_at=$5, updated_at=now()
       where lower(email)=lower($1)`,
      [email, planId, tier, status, endAt]
    );
    await db.query(
      `insert into memberships (email, plan_id, tier, status, start_at, end_at, updated_at)
       select lower($1), $2, $3, $4, now(), $5, now()
       where not exists (select 1 from memberships where lower(email)=lower($1))`,
      [email, planId, tier, status, endAt]
    );
  }
}

// POST /api/pay/flow/confirm  (server-to-server from Flow)
module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "method_not_allowed" });

  try {
    // Flow sends token either in body form or query
    let token =
      (req.query && req.query.token) ||
      (req.body && (req.body.token || req.body.TOKEN)) ||
      null;

    // If Vercel didn't parse body, parse manually
    if (!token) {
      await new Promise((resolve) => {
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", () => {
          if (raw) {
            const parsed = qs.parse(raw);
            token = parsed.token || parsed.TOKEN || null;
          }
          resolve();
        });
      });
    }

    if (!token) return res.status(400).json({ ok: false, error: "missing_token" });

    // 1) Ask Flow for status (retry-friendly)
    const statusResp = await flowPost("/payment/getStatus", { token });

    // Flow: status suele ser numérico (2=pagado)
    const statusRaw =
      (statusResp && (statusResp.status ?? statusResp.paymentStatus ?? statusResp.state)) ?? null;
    const statusNum = statusRaw == null ? NaN : Number(statusRaw);
    const statusStr = statusRaw == null ? "" : String(statusRaw).toLowerCase();
    const isPaid = statusNum === 2 || statusStr === "paid";

    // Store raw status
    try {
      await db.query(
        `insert into payment_intents (flow_token, status, raw_status, updated_at)
         values ($1, $2, $3, now())
         on conflict (flow_token) do update set status=$2, raw_status=$3, updated_at=now()`,
        [token, isPaid ? "paid" : "pending", statusResp || null]
      );
    } catch (e) {
      // ignore schema mismatch
    }

    if (!isPaid) return res.status(200).json({ ok: true, paid: false });

    // 2) Resolve payer email + planId
    // Prefer DB payment_intents, but fall back to Flow "optional" payload.
    let email = null;
    let planId = null;
    let tier = null;

    try {
      const r = await db.query(
        `select email, plan_id from payment_intents where flow_token=$1 limit 1`,
        [token]
      );
      email = r?.rows?.[0]?.email || null;
      planId = r?.rows?.[0]?.plan_id || null;
    } catch (e) {}

    // Fallback: Flow devuelve "optional" (string) en getStatus
    if ((!email || !planId) && statusResp?.optional) {
      try {
        const opt = typeof statusResp.optional === "string" ? JSON.parse(statusResp.optional) : statusResp.optional;
        if (!email && opt?.email) email = String(opt.email).trim().toLowerCase();
        if (!planId && opt?.planId) planId = String(opt.planId).trim();
      } catch (_) {}
    }

    // Extra fallback: algunos responses traen email directo
    if (!email && statusResp?.payerEmail) email = String(statusResp.payerEmail).trim().toLowerCase();
    if (!email && statusResp?.email) email = String(statusResp.email).trim().toLowerCase();

    if (planId && plans?.[planId]?.tier) tier = plans[planId].tier;

    if (!email || !planId) {
      // If not found, still acknowledge Flow to avoid duplicate callbacks
      return res.status(200).json({ ok: true, paid: true, activated: false });
    }

    // 3) Activate membership (upsert)
    await ensureMembershipsTable();

    const days = plans?.[planId]?.days ?? null;
    const endAt = days ? new Date(Date.now() + Number(days) * 24 * 60 * 60 * 1000) : null;

    await upsertMembership({
      email,
      planId,
      tier: tier || null,
      status: "active",
      endAt,
    });

    return res.status(200).json({ ok: true, paid: true, activated: true, email, planId, tier: tier || null });
  } catch (err) {
    console.error("[FLOW_CONFIRM] error", err);
    // IMPORTANT: reply 200 so Flow doesn't keep retrying forever
    return res.status(200).json({ ok: false, error: "confirm_failed" });
  }
};
