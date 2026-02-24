const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const querystring = require("querystring");

const router = express.Router();

/**
 * FLOW integration (Pago Ecommerce /payment/create + /payment/getStatus)
 *
 * ENV:
 *  FLOW_API_URL=https://www.flow.cl/api  (prod)  or https://sandbox.flow.cl/api
 *  FLOW_API_KEY=...
 *  FLOW_SECRET_KEY=...
 *  FRONTEND_URL=https://factorvictoria.com
 *
 * NOTE:
 *  Flow expects application/x-www-form-urlencoded
 *  Signature param is named `s` and is HMAC-SHA256 over sorted key+value concatenation.
 *  Docs: /payment/create requires apiKey, commerceOrder, subject, amount, email, urlConfirmation, urlReturn. Currency optional.
 */

function flowSign(params, secretKey) {
  const keys = Object.keys(params).sort();
  let toSign = "";
  for (const k of keys) toSign += k + String(params[k]);
  return crypto.createHmac("sha256", secretKey).update(toSign).digest("hex");
}

function getFlowConfig() {
  const apiUrl = process.env.FLOW_API_URL || "https://www.flow.cl/api";
  const apiKey = process.env.FLOW_API_KEY;
  const secretKey = process.env.FLOW_SECRET_KEY;
  const frontendUrl = process.env.FRONTEND_URL || "https://factorvictoria.com";
  if (!apiKey || !secretKey) throw new Error("Missing FLOW_API_KEY / FLOW_SECRET_KEY");
  return { apiUrl, apiKey, secretKey, frontendUrl };
}

// Central pricing (keep in ONE place)
const PLANS = {
  "monthly": { label: "Mensual", amount: 19990 },
  "quarterly": { label: "Trimestral", amount: 44990 },
  "annual": { label: "Anual", amount: 99990 },
  "lifetime": { label: "Vitalicio", amount: 249990 },
};

/**
 * POST /api/pay/flow/create
 * body: { planId, email, userId }
 * returns: { checkoutUrl, token, commerceOrder }
 */
router.post("/flow/create", async (req, res) => {
  try {
    const { planId, email, userId } = req.body || {};
    if (!planId || !PLANS[planId]) return res.status(400).json({ error: "planId inválido" });
    if (!email) return res.status(400).json({ error: "email requerido" });

    const { apiUrl, apiKey, secretKey, frontendUrl } = getFlowConfig();

    // Make commerceOrder traceable: FV-<planId>-<userId>-<timestamp>-<rand>
    const commerceOrder = [
      "FV",
      planId,
      userId || "guest",
      Date.now(),
      crypto.randomBytes(3).toString("hex"),
    ].join("-");

    const params = {
      apiKey,
      commerceOrder,
      subject: `Factor Victoria - ${PLANS[planId].label}`,
      currency: "CLP",
      amount: PLANS[planId].amount,
      email,
      urlConfirmation: `${frontendUrl.replace(/\/$/, "")}/api/pay/flow/confirm`,
      urlReturn: `${frontendUrl.replace(/\/$/, "")}/perfil?pay=flow&order=${encodeURIComponent(commerceOrder)}`,
    };

    const s = flowSign(params, secretKey);
    const body = querystring.stringify({ ...params, s });

    const resp = await axios.post(`${apiUrl}/payment/create`, body, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 15000,
    });

    // Flow returns { url, token, flowOrder }
    const { url, token } = resp.data || {};
    if (!url || !token) return res.status(502).json({ error: "Respuesta Flow inválida", data: resp.data });

    // TODO (recomendado): guardar orden en DB como PENDING con token/commerceOrder/userId/planId
    // await db.createPaymentIntent({ provider:"flow", token, commerceOrder, planId, userId, email, status:"pending" })

    return res.json({ checkoutUrl: `${url}?token=${token}`, token, commerceOrder });
  } catch (err) {
    console.error("FLOW create error:", err?.response?.data || err);
    return res.status(500).json({ error: "Error creando pago Flow", details: err?.response?.data || String(err) });
  }
});

module.exports = router;
