const cors = require("../../_cors");
const db = require("../../_db");
const plans = require("../../_plans");
const { flowPost } = require("./_flow");

function parseCommerceOrder(co) {
  // Formato: FV|<planId>|<email>|<ts>
  try {
    const s = String(co || "");
    const parts = s.split("|");
    if (parts.length >= 3 && parts[0] === "FV") {
      return { planId: parts[1] || null, email: parts[2] || null };
    }
  } catch (e) {}
  return { planId: null, email: null };
}
const qs = require("querystring");

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== "POST" && req.method !== "GET") return res.status(405).send("Method not allowed");

  try {
    // --- Leer body aunque venga como x-www-form-urlencoded y Vercel no lo parsee ---
    let token = req.body?.token || req.query?.token;

    // si req.body viene como string o buffer
    if (!token && (typeof req.body === "string" || Buffer.isBuffer(req.body))) {
      const parsed = qs.parse(req.body.toString());
      token = parsed.token;
    }

    // si req.body viene vacío, leer el stream manualmente
    if (!token) {
      const raw = await new Promise((resolve) => {
        let data = "";
        req.on("data", (chunk) => (data += chunk));
        req.on("end", () => resolve(data));
        req.on("error", () => resolve(""));
      });
      if (raw) {
        const parsed = qs.parse(raw);
        token = parsed.token;
      }
    }

    // Responder rápido a Flow
    res.status(200).send("OK");

    if (!token) return;

    // 1) Consultar estado en Flow
    const statusData = await flowPost("/payment/getStatus", { token });

    const status = Number(statusData?.status);
    const commerceOrder = statusData?.commerceOrder;
    const flowOrder = statusData?.flowOrder || null;

    // Guardar el pago
    try {
      await db.query(
        `insert into payments (flow_order, commerce_order, status, raw)
         values ($1,$2,$3,$4)
         on conflict (flow_order) do update set status = excluded.status, raw = excluded.raw`,
        [flowOrder || 0, commerceOrder || null, status || null, statusData]
      );
    } catch (e) {}

    if (status !== 2 || !commerceOrder) return;

    // 2) Leer intent para saber plan/email/user
    let intent;
    try {
      const r = await db.query(
        "select plan_id, email, user_id from payment_intents where commerce_order = $1 limit 1",
        [commerceOrder]
      );
      intent = r.rows?.[0];
    } catch (e) {}

    // Fallback: si por cualquier motivo no existe intent, intentamos derivar desde commerceOrder.
    const parsed = parseCommerceOrder(commerceOrder);

    const planId = intent?.plan_id || parsed.planId;
    const emailRaw = intent?.email || parsed.email || statusData?.payer || statusData?.email;
    const email = emailRaw ? String(emailRaw).trim().toLowerCase() : null;
    const userId = intent?.user_id || null;

    if (!planId || !plans[planId] || !email) return;

    const now = new Date();
    const planDays = plans[planId]?.days;
    const end = planDays == null ? null : new Date(now.getTime() + planDays * 24 * 60 * 60 * 1000);

    // 3) Activar membresía
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

      await db.query(
        "update payment_intents set status = 'paid' where commerce_order = $1",
        [commerceOrder]
      );
    } catch (e) {}
  } catch (err) {
    // Ojo: si falló antes de responder, intenta responder
    try { res.status(200).send("OK"); } catch (_) {}
    console.error("flow confirm error:", err);
  }
};
