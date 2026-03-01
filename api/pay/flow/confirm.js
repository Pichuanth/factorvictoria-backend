const cors = require("../../_cors");
const db = require("../../_db");
const plans = require("../../_plans");
const { createActivationToken } = require("../../_activation");
const { sendActivationEmail } = require("../../_mail");
const { flowPost } = require("./_flow");

function parseBody(req) {
  const ct = String(req.headers["content-type"] || "").toLowerCase();
  if (ct.includes("application/json")) return req.body || {};
  // Flow normalmente manda x-www-form-urlencoded
  if (typeof req.body === "string") {
    try {
      const params = new URLSearchParams(req.body);
      return Object.fromEntries(params.entries());
    } catch (_) {
      return {};
    }
  }
  return req.body || {};
}

function parseCommerceOrder(co) {
  try {
    const s = String(co || "");
    const parts = s.split("|");
    if (parts.length >= 3 && parts[0] === "FV") {
      return { planId: parts[1] || null, email: parts[2] || null };
    }
  } catch (e) {}
  return { planId: null, email: null };
}

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // IMPORTANT: responder 200 rápido para que Flow no marque error
  try {
    const body = parseBody(req);
    const token = body.token || body?.params?.token;

    if (!token) return res.status(200).send("OK");

    // Consultar status a Flow
    const st = await flowPost("/payment/getStatus", { token });
    const status = Number(st?.status);
    const isPaid = status === 2;

    const commerceOrder = String(st?.commerceOrder || "").trim();
    const parsed = parseCommerceOrder(commerceOrder);

    // Buscar payment_intent para email/plan
    let intent;
    try {
      const r = await db.query(
        "select plan_id, email, user_id from payment_intents where commerce_order = $1 limit 1",
        [commerceOrder]
      );
      intent = r.rows?.[0];
    } catch (e) {}

    const planId = intent?.plan_id || parsed.planId;
    const emailRaw = intent?.email || parsed.email || null;
    const email = emailRaw ? String(emailRaw).trim().toLowerCase() : null;
    const userId = intent?.user_id || null;

    // Persist best-effort payment row
    try {
      await db.query(
        `insert into payments (flow_order, commerce_order, status, raw)
         values ($1,$2,$3,$4)
         on conflict (flow_order) do update set status = excluded.status, raw = excluded.raw`,
        [Number(st?.flowOrder || 0), commerceOrder, status || null, st]
      );
    } catch (_) {}

    if (!isPaid) {
      try {
        await db.query("update payment_intents set status = 'created' where commerce_order = $1", [commerceOrder]);
      } catch (_) {}
      return res.status(200).send("OK");
    }

    // Activar membresía idempotente
    if (planId && plans[planId] && email) {
      const FRONTEND_URL = process.env.FRONTEND_URL || "https://factorvictoria.com";
      const now = new Date();
      const planDays = plans[planId]?.days;
      const end = planDays == null ? null : new Date(now.getTime() + planDays * 24 * 60 * 60 * 1000);

      try {
        await db.query(
          `insert into memberships (email, user_id, plan_id, tier, status, start_at, end_at)
           values ($1,$2,$3,$4,'active',$5,$6)
           on conflict (email) do update set
             user_id = excluded.user_id,
             plan_id = excluded.plan_id,
             tier = excluded.tier,
             status = 'active',
             start_at = excluded.start_at,
             end_at = excluded.end_at`,
          [email, userId, planId, plans[planId].tier, now.toISOString(), end ? end.toISOString() : null]
        );

        await db.query("update payment_intents set status = 'paid' where commerce_order = $1", [commerceOrder]);
      } catch (e) {
        console.error("[FLOW_CONFIRM] activate membership failed", e);
      }

      // activation mail (best-effort)
      try {
        const actToken = await createActivationToken(email);
        const activationLink = `${FRONTEND_URL}/activar?token=${actToken}`;
        await sendActivationEmail({ to: email, activationLink });
      } catch (_) {}
    }

    return res.status(200).send("OK");
  } catch (err) {
    console.error("flow confirm error:", err);
    // OJO: igual responde 200 para que Flow no reintente infinito, pero se verá en logs
    return res.status(200).send("OK");
  }
};
