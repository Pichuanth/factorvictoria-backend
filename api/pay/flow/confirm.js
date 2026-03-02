const cors = require("../../_cors");
const db = require("../../_db");
const qs = require("querystring");
const flow = require("./_flow");

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
    const testMode = String(process.env.FLOW_TEST_MODE || "").toLowerCase() === "true";
    const statusResp = await flow.getStatus({ token, testMode });

    // Flow response shape depends on API; we try common flags
    const status = (statusResp && (statusResp.status || statusResp.paymentStatus || statusResp.state)) || null;
    const isPaid =
      status === "paid" ||
      status === "PAID" ||
      status === 2 || // some APIs use numeric
      statusResp?.paymentStatus === 2;

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

    // 2) Resolve payer email + planId from payment_intents (created on /create)
    let email = null;
    let planId = null;

    try {
      const r = await db.query(
        `select email, plan_id from payment_intents where flow_token=$1 limit 1`,
        [token]
      );
      email = r?.rows?.[0]?.email || null;
      planId = r?.rows?.[0]?.plan_id || null;
    } catch (e) {}

    if (!email || !planId) {
      // If not found, still acknowledge Flow to avoid duplicate callbacks
      return res.status(200).json({ ok: true, paid: true, activated: false });
    }

    // 3) Activate membership (upsert)
    const planDays = {
      mensual: 30,
      trimestral: 120,
      anual: 365,
      vitalicio: null,
    };

    const days = planDays[planId] ?? 30;
    const endAtSql = days ? "now() + ($2::int || ' days')::interval" : "NULL";

    // Ensure table exists and upsert works
    await db.query(
      `insert into memberships (email, plan_id, status, start_at, end_at, updated_at)
       values (lower($1), $2, 'active', now(), ${endAtSql}, now())
       on conflict (email) do update set plan_id=excluded.plan_id, status='active', start_at=now(), end_at=${endAtSql}, updated_at=now()`,
      days ? [email, planId, days] : [email, planId]
    );

    return res.status(200).json({ ok: true, paid: true, activated: true, email: email, planId: planId });
  } catch (err) {
    console.error("[FLOW_CONFIRM] error", err);
    // IMPORTANT: reply 200 so Flow doesn't keep retrying forever
    return res.status(200).json({ ok: false, error: "confirm_failed" });
  }
};
