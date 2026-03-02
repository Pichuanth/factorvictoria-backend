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
    // Vercel/Node sometimes provides req.body as a string
    let body = req.body;
    try {
      if (typeof body === "string") body = JSON.parse(body);
    } catch {
      // ignore
    }

    const { planId, email, userId, returnPath } = body || {};
    if (!planId || !plans[planId]) return res.status(400).json({ error: "planId inválido" });
    if (!email) return res.status(400).json({ error: "email requerido" });

    // Normaliza email para consistencia (login/memberships)
    const emailNorm = String(email).trim().toLowerCase();
    const plan = plans[planId];

    // === Test mode (para pruebas sin cobrar monto real) ===
    const testMode = String(process.env.FLOW_TEST_MODE || "").toLowerCase() === "true";
    const testAmount = Number(process.env.FLOW_TEST_AMOUNT_CLP || 1000);
    const amount = testMode ? testAmount : plan.amount;

    // Prefer explicit envs, but fall back to request headers to avoid hard failures
    const BACKEND_URL =
      process.env.BACKEND_URL ||
      (req.headers.host ? `https://${req.headers.host}` : "");

    const FRONTEND_URL =
      process.env.FRONTEND_URL ||
      (typeof req.headers.origin === "string" ? req.headers.origin : "https://factorvictoria.com");

    if (!BACKEND_URL) {
      console.error("[FLOW_CREATE] missing BACKEND_URL and cannot infer from req.headers.host");
      return res.status(500).json({ error: "BACKEND_URL missing" });
    }

    // commerceOrder único
    const commerceOrder = `FV${Date.now()}`;

    const optional = JSON.stringify({
      planId,
      email: emailNorm,
      userId: userId || null,
    });

    // NOTIFICATION URL (Flow enviará POST token=... aquí)
    const urlConfirmation = `${BACKEND_URL}/api/pay/flow/confirm`;

    // RETURN URL (usuario vuelve al front)
    // - Usamos el frontend directamente para mejorar UX.
    // - Pasamos order + email para que el front pueda mostrar estado y hacer polling si lo necesitas.
    const rp = typeof returnPath === "string" && returnPath.startsWith("/") ? returnPath : "/login";
    const urlReturn = `${FRONTEND_URL}${rp}?email=${encodeURIComponent(emailNorm)}&paid=0&order=${encodeURIComponent(
      commerceOrder
    )}`;

    console.log("[FLOW_CREATE] start", { planId, email: emailNorm, amount, testMode, commerceOrder });

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

    const token = data.token || null;
    const flowOrder = data.flowOrder || null;

    // Persist intent (si DB está configurada)
    try {
      await db.query(
        `insert into payment_intents (commerce_order, plan_id, email, user_id, flow_token, flow_order, status)
         values ($1,$2,$3,$4,$5,$6,$7)
         on conflict (commerce_order) do update set
           plan_id = excluded.plan_id,
           email = excluded.email,
           user_id = excluded.user_id,
           flow_token = excluded.flow_token,
           flow_order = excluded.flow_order,
           status = excluded.status`,
        [commerceOrder, planId, emailNorm, userId || null, token, flowOrder, "created"]
      );
    } catch (e) {
      console.warn("[FLOW_CREATE] could not persist intent:", e?.message || e);
    }

    const checkoutUrl = data.url ? `${data.url}?token=${encodeURIComponent(token)}` : null;

    console.log("[FLOW_CREATE] ok", { commerceOrder, flowOrder, hasCheckoutUrl: !!checkoutUrl });

    return res.status(200).json({
      ok: true,
      amount,
      testMode,
      planId,
      commerceOrder,
      flowOrder,
      token,
      // Frontend expects "url"
      url: checkoutUrl,
      // Backward/compat aliases
      paymentUrl: checkoutUrl,
      checkoutUrl,
    });
  } catch (err) {
    console.error("[FLOW_CREATE] error:", err);
    return res.status(500).json({ error: "flow create failed", detail: String(err?.message || err) });
  }
};
