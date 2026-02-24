// backend/api/pay/flow/confirm.js
const cors = require("../../_cors");
const db = require("../../_db");
const plans = require("../../_plans");
const { flowPost } = require("./_flow");

// Flow confirmará vía POST x-www-form-urlencoded con token=XXXX
// POST /api/pay/flow/confirm
module.exports = async (req, res) => {
  if (cors(req, res)) return;

  if (req.method !== "POST") return res.status(405).send("Method not allowed");

  // Responder rápido a Flow
  res.status(200).send("OK");

  try {
    const token = req.body?.token || req.query?.token;
    if (!token) return;

    // 1) Consultar estado en Flow
    const statusData = await flowPost("/payment/getStatus", { token });

    // Según docs Flow: status 2 = pagado (confirmado)
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

    const planId = intent?.plan_id;
    const email = intent?.email || statusData?.payer || statusData?.email;
    const userId = intent?.user_id || null;

    if (!planId || !plans[planId] || !email) return;

    const now = new Date();
    const end = new Date(now.getTime() + plans[planId].days * 24 * 60 * 60 * 1000);

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
        [email, userId, planId, plans[planId].tier, now.toISOString(), end.toISOString()]
      );

      await db.query(
        "update payment_intents set status = 'paid' where commerce_order = $1",
        [commerceOrder]
      );
    } catch (e) {}
  } catch (err) {
    // No podemos responder porque ya respondimos OK. Log silencioso.
    console.error("flow confirm error:", err);
  }
};
