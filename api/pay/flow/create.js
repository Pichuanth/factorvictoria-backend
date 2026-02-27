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

    // Normaliza email para consistencia (login/memberships)
    const emailNorm = String(email).trim().toLowerCase();

    const plan = plans[planId];

    // === Test mode (para pruebas sin cobrar monto real) ===
    const testMode = String(process.env.FLOW_TEST_MODE || "").toLowerCase() === "true";
    const testAmount = Number(process.env.FLOW_TEST_AMOUNT_CLP || 1000);
    const amount = testMode ? testAmount : plan.amount;

    const BACKEND_URL = process.env.BACKEND_URL;
    const FRONTEND_URL = process.env.FRONTEND_URL;
    if (!BACKEND_URL || !FRONTEND_URL) return res.status(500).json({ error: "BACKEND_URL/FRONTEND_URL missing" });

    // commerceOrder único
    const commerceOrder = `FV|${planId}|${emailNorm}|${Date.now()}`;

    const optional = JSON.stringify({
      planId,
      email: emailNorm,
      userId: userId || null,
    });

    const urlConfirmation = `${BACKEND_URL}/api/pay/flow/confirm`;
    const urlReturn = `${FRONTEND_URL}${returnPath || "/perfil"}?flow=return&order=${encodeURIComponent(commerceOrder)}`;

    const data = await flowPost("/payment/create", {
      commerceOrder,
      subject: `FactorVictoria - ${planId}`,
      currency: "CLP",
      amount: amount,
      email: emailNorm,
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
        [commerceOrder, planId, emailNorm, userId || null, data.token || null, data.flowOrder || null, "created"]
      );
    } catch (e) {
      // no romper si DB no está lista
    }

    const checkoutUrl = data.url ? `${data.url}?token=${encodeURIComponent(data.token)}` : null;

    return res.status(200).json({
      ok: true,
      amount,
      testMode,
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
