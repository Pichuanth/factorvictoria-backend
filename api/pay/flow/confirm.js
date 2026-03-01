const cors = require("../../_cors");
const db = require("../../_db");
const { createActivationToken } = require("../../_activation");
const { sendActivationEmail } = require("../../_mail");
const plans = require("../_plans");
const { flowPost } = require("./_flow");

// Flow notifies payment result here.
// POST /api/pay/flow/confirm  body: token=... (x-www-form-urlencoded) OR JSON { token }
module.exports = async (req, res) => {
  if (cors(req, res)) return;

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const token =
      (req.body && (req.body.token || req.body.TOKEN)) ||
      (req.query && (req.query.token || req.query.TOKEN)) ||
      null;

    if (!token) return res.status(400).json({ error: "Missing token" });

    console.log("[FLOW_CONFIRM] token received", { token: String(token).slice(0, 6) + "..." });

    // Ask Flow for definitive status
    const statusData = await flowPost("/payment/getStatus", { token });
    const commerceOrder = statusData?.commerceOrder || null;
    const flowOrder = statusData?.flowOrder || null;
    const flowStatus = Number(statusData?.status);

    if (!commerceOrder) {
      return res.status(400).json({ error: "Missing commerceOrder from Flow status" });
    }

    // Load existing intent (if exists)
    const r = await db.query(
      "select commerce_order, plan_id, email, user_id from payment_intents where commerce_order=$1 limit 1",
      [commerceOrder]
    );
    const intent = r?.rows?.[0] || null;

    // Persist status (idempotent)
    try {
      await db.query(
        `insert into payment_intents (commerce_order, plan_id, email, user_id, flow_token, flow_order, status)
         values ($1,$2,$3,$4,$5,$6,$7)
         on conflict (commerce_order) do update set
           plan_id = coalesce(excluded.plan_id, payment_intents.plan_id),
           email = coalesce(excluded.email, payment_intents.email),
           user_id = coalesce(excluded.user_id, payment_intents.user_id),
           flow_token = excluded.flow_token,
           flow_order = excluded.flow_order,
           status = excluded.status,
           updated_at = now()`,
        [
          commerceOrder,
          intent?.plan_id || null,
          intent?.email || null,
          intent?.user_id || null,
          token,
          flowOrder,
          String(flowStatus),
        ]
      );
    } catch (e) {
      console.warn("[FLOW_CONFIRM] could not persist status:", e?.message || e);
    }

    // If not paid, just ACK
    if (flowStatus !== 2) {
      return res.status(200).json({ ok: true, paid: false, status: flowStatus, commerceOrder });
    }

    // Activate membership (requires plan/email from intent)
    const planId = intent?.plan_id || null;
    const email = intent?.email || null;

    if (!planId || !email) {
      // We don't fail the webhook; we just log.
      console.warn("[FLOW_CONFIRM] paid but missing plan/email", { planId, email, commerceOrder });
      return res.status(200).json({ ok: true, paid: true, status: flowStatus, commerceOrder });
    }

    const plan = plans?.[planId];
    const days = Number(plan?.days || 30);
    const now = new Date();
    const activeUntil = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

    await db.query(
      `insert into memberships (email, tier, plan_id, status, active_until, cancel_at_period_end, created_at, updated_at)
       values ($1,'pro',$2,'active',$3,false,now(),now())
       on conflict (email) do update set
         tier='pro',
         plan_id=excluded.plan_id,
         status='active',
         active_until=excluded.active_until,
         cancel_at_period_end=false,
         updated_at=now()`,
      [email, planId, activeUntil.toISOString()]
    );

    // Email activation link (best-effort)
    try {
      const t = await createActivationToken({ email });
      const FRONTEND_URL = process.env.FRONTEND_URL || "https://factorvictoria.com";
      const link = `${FRONTEND_URL}/activate?token=${encodeURIComponent(t)}`;
      await sendActivationEmail(email, link);
    } catch (e) {
      console.warn("[FLOW_CONFIRM] could not send activation email:", e?.message || e);
    }

    return res.status(200).json({ ok: true, paid: true, status: flowStatus, commerceOrder, email, planId });
  } catch (err) {
    console.error("[FLOW_CONFIRM] error:", err);
    return res.status(500).json({ error: "confirm failed", detail: String(err?.message || err) });
  }
};
