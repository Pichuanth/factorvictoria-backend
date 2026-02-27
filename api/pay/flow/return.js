// backend/api/pay/flow/return.js
// Fallback activación: si el usuario vuelve desde Flow y por algún motivo no llegó el notify a /confirm,
// el frontend puede llamar:
//
// GET /api/pay/flow/return?order=FV|plan|email|ts
//
// Este endpoint busca el token en payment_intents, consulta getStatus y activa membership si está pagado.
const cors = require("../../_cors");
const db = require("../../_db");
const { createActivationToken } = require("../../_activation");
const { sendActivationEmail } = require("../../_mail");
const plans = require("../../_plans");
const { flowPost } = require("./_flow");

function parseCommerceOrder(co) {
  try {
    const s = String(co || "");
    const parts = s.split("|");
    if (parts.length >= 3 && parts[0] === "FV") return { planId: parts[1] || null, email: parts[2] || null };
  } catch (e) {}
  return { planId: null, email: null };
}

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    const commerceOrder = req.query?.order ? String(req.query.order) : null;
    if (!commerceOrder) return res.status(400).json({ error: "order requerido" });

    const parsed = parseCommerceOrder(commerceOrder);

    const r = await db.query(
      "select plan_id, email, user_id, flow_token, flow_order, status from payment_intents where commerce_order = $1 limit 1",
      [commerceOrder]
    );
    const intent = r.rows?.[0];
    if (!intent?.flow_token) {
      return res.status(404).json({ ok: false, error: "intent no encontrado o sin token", commerceOrder });
    }

    // Consultar estado en Flow
    const statusData = await flowPost("/payment/getStatus", { token: intent.flow_token });
    const status = Number(statusData?.status);
    const flowOrder = statusData?.flowOrder || intent.flow_order || null;

    if (status !== 2) {
  
// Enviar link de activación para crear contraseña (best-effort)
let activationLink = "";
try {
  const FRONTEND_URL = process.env.FRONTEND_URL || "https://factorvictoria.com";
  const actToken = await createActivationToken(email);
  activationLink = `${FRONTEND_URL}/activar?token=${actToken}`;
  await sendActivationEmail({ to: email, activationLink });
  console.log("[FLOW_RETURN] activation email prepared", { email });
} catch (e2) {
  console.log("[FLOW_RETURN] activation email skipped/failed", e2?.message || e2);
}

    return res.status(200).json({ ok: true, paid: false, status, commerceOrder, flowOrder });
    }

    const planId = intent.plan_id || parsed.planId;
    const emailRaw = intent.email || parsed.email || statusData?.payer || statusData?.email;
    const email = emailRaw ? String(emailRaw).trim().toLowerCase() : null;

    if (!planId || !plans[planId] || !email) {
      return res.status(400).json({ ok: false, error: "no se pudo derivar plan/email", commerceOrder, planId, email });
    }

    const now = new Date();
    const planDays = plans[planId]?.days;
    const end = planDays == null ? null : new Date(now.getTime() + planDays * 24 * 60 * 60 * 1000);

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
      [email, intent.user_id || null, planId, plans[planId].tier, now.toISOString(), end ? end.toISOString() : null]
    );

    await db.query("update payment_intents set status = 'paid' where commerce_order = $1", [commerceOrder]);

    // Persist payment best-effort
    try {
      await db.query(
        `insert into payments (flow_order, commerce_order, status, raw)
         values ($1,$2,$3,$4)
         on conflict (flow_order) do update set status = excluded.status, raw = excluded.raw`,
        [flowOrder || 0, commerceOrder, status, statusData]
      );
    } catch (e) {}

    return res.status(200).json({
      ok: true,
      paid: true,
      planId,
      tier: plans[planId].tier,
      email,
      commerceOrder,
      flowOrder,
      activationLink,
    });
  } catch (err) {
    console.error("[FLOW_RETURN] error:", err);
    return res.status(500).json({ ok: false, error: "flow return failed", detail: String(err?.message || err) });
  }
};
