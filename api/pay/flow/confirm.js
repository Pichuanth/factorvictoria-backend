const cors = require("../../_cors");
const db = require("../../_db");
const { flowPost } = require("./_flow");

// POST /api/pay/flow/confirm
// Flow calls this "confirmation" URL server-to-server after payment.
// We mark the intent as paid and create an ACTIVE membership record in `memberships`.
module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  let body = {};
  try { body = req.body || JSON.parse(req.body || "{}"); } catch {}
  const token = String(body.token || body.token_ws || body.tokenws || "").trim();
  const testMode = body.testMode === true || String(body.testMode || "").toLowerCase() === "true";

  if (!token) return res.status(400).json({ ok: false, error: "token_required" });

  try {
    // 1) Ask Flow for status
    const status = await flowPost("/payment/getStatus", { token }, { testMode });

    const order = String(status?.flowOrder || status?.flow_order || "").trim();
    const commerceOrder = String(status?.commerceOrder || status?.commerce_order || "").trim();
    const payerEmail = String(status?.payer || status?.userEmail || status?.user_email || "").trim().toLowerCase();

    // Flow paid status is usually: status === 2 (paid)
    const paid = Number(status?.status) === 2;

    // 2) Load intent data (email/planId) if we have it
    let intent = null;
    if (commerceOrder) {
      try {
        const r = await db.query(
          `select id, email, plan_id, user_id
             from payment_intents
            where commerce_order = $1
            order by created_at desc
            limit 1`,
          [commerceOrder]
        );
        intent = r?.rows?.[0] || null;
      } catch (e) {
        console.log("[FLOW_CONFIRM] payment_intents lookup failed:", e?.message || e);
      }
    }

    const email = String(intent?.email || payerEmail || "").trim().toLowerCase();
    const planId = String(intent?.plan_id || "").trim() || "mensual";
    const tier = (planId.includes("-") ? planId.split("-")[0] : planId) || "pro";

    // 3) Persist raw status + mark intent paid
    try {
      if (commerceOrder) {
        await db.query(
          `update payment_intents
              set status = $2,
                  flow_order = $3,
                  raw_flow_status = $4,
                  updated_at = now()
            where commerce_order = $1`,
          [commerceOrder, paid ? "paid" : "pending", order || null, status || null]
        );
      }
    } catch (e) {
      console.log("[FLOW_CONFIRM] payment_intents update failed:", e?.message || e);
    }

    // 4) Activate membership (most important)
    if (paid && email) {
      const now = new Date();
      const addDays = (d) => new Date(now.getTime() + d * 24 * 60 * 60 * 1000);
      let endAt = null;

      const p = planId.toLowerCase();
      if (p.includes("mens")) endAt = addDays(31);
      else if (p.includes("trim") || p.includes("3")) endAt = addDays(93);
      else if (p.includes("anual") || p.includes("12")) endAt = addDays(366);
      else if (p.includes("vital")) endAt = null; // lifetime

      try {
        // NOTE: we write into `memberships` (plural). Your DB uses memberships (membership table does NOT exist).
        await db.query(
          `insert into memberships (email, plan_id, tier, status, start_at, end_at, created_at)
           values ($1, $2, $3, 'active', now(), $4, now())`,
          [email, planId, tier, endAt ? endAt.toISOString() : null]
        );
        console.log("[FLOW_CONFIRM] membership activated ✅", { email, planId, tier, order, commerceOrder });
      } catch (e) {
        console.log("[FLOW_CONFIRM] memberships insert failed:", e?.message || e);
      }
    } else {
      console.log("[FLOW_CONFIRM] not paid or missing email", { paid, email, order, commerceOrder });
    }

    // Flow expects 200/OK
    return res.status(200).json({ ok: true, paid, order, commerceOrder });
  } catch (e) {
    console.log("[FLOW_CONFIRM] getStatus error:", e?.message || e);
    return res.status(500).json({ ok: false, error: "confirm_failed" });
  }
};
