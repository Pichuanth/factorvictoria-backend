// backend/api/pay/flow/create.js
const cors = require("../../_cors");
const plans = require("../../_plans");
const db = require("../../_db");
const { flowPost } = require("./_flow");

// POST /api/pay/flow/create
// body: { planId, email, userId, returnPath? }
module.exports = async (req, res) => {
  if (cors(req, res)) return;

  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { planId, email, userId, returnPath } = req.body || {};
    if (!planId || !plans[planId]) return res.status(400).json({ error: "planId inválido" });
    if (!email) return res.status(400).json({ error: "email requerido" });

    const plan = plans[planId];
    const BACKEND_URL = process.env.BACKEND_URL;
    const FRONTEND_URL = process.env.FRONTEND_URL;
    if (!BACKEND_URL || !FRONTEND_URL) return res.status(500).json({ error: "BACKEND_URL/FRONTEND_URL missing" });

    // commerceOrder único
    const commerceOrder = `FV-${planId}-${Date.now()}`;

    const optional = JSON.stringify({
      planId,
      email,
      userId: userId || null,
    });

    const urlConfirmation = `${BACKEND_URL}/api/pay/flow/confirm`;
    const urlReturn = `${FRONTEND_URL}${returnPath || "/perfil"}?flow=return&order=${encodeURIComponent(commerceOrder)}`;

    const data = await flowPost("/payment/create", {
      commerceOrder,
      subject: `FactorVictoria - ${planId}`,
      currency: "CLP",
      amount: plan.amount,
      email,
      urlConfirmation,
      urlReturn,
      optional,
    });

    // Persist intent (si DB está configurada)
    try {
      await db.query(
        `insert into payment_intents (commerce_order, plan_id, email, user_id, flow_token, flow_order, status)
         values ($1,$2,$3,$4,$5,$6,$7)
         on conflict (commerce_order) do nothing`,
        [commerceOrder, planId, email, userId || null, data.token || null, data.flowOrder || null, "created"]
      );
    } catch (e) {
      // no romper si DB no está lista
    }

    const checkoutUrl = data.url ? `${data.url}?token=${encodeURIComponent(data.token)}` : null;

    return res.status(200).json({
      ok: true,
      planId,
      commerceOrder,
      flowOrder: data.flowOrder || null,
      token: data.token || null,
      checkoutUrl,
    });
  } catch (err) {
    return res.status(500).json({ error: "flow create failed", detail: String(err?.message || err) });
  }
};
