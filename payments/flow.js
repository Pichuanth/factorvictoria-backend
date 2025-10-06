// payments/flow.js
const crypto = require("crypto");

module.exports = (env) => {
  const base = (env.FLOW_API_BASE || "").replace(/\/+$/, "");
  const apiKey = env.FLOW_API_KEY;
  const secret = env.FLOW_SECRET;

  function sign(params) {
    const qs = Object.keys(params)
      .sort()
      .map((k) => `${k}=${params[k]}`)
      .join("&");
    return crypto.createHmac("sha256", secret).update(qs).digest("hex");
  }

  async function createPayment({ orderId, amount, email, concept, returnUrl, webhookUrl }) {
    const payload = {
      apiKey,
      commerceOrder: orderId,
      subject: concept,
      currency: "CLP",
      amount: Number(amount),
      email,
      urlConfirmation: webhookUrl,
      urlReturn: returnUrl,
    };
    payload.s = sign(payload);

    const r = await fetch(`${base}/payment/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Flow ${r.status}: ${JSON.stringify(data)}`);

    // Flow suele devolver token + url
    const redirectUrl = data.url || data.paymentUrl || data.redirectUrl;
    const providerId = data.token || data.flowOrder || data.id || String(orderId);
    return { providerId, redirectUrl };
  }

  function verifyWebhook(rawBody, headers) {
    try {
      const sig = headers["x-flow-signature"] || headers["x-signature"];
      if (!secret || !sig) return true; // sin verificación estricta
      const calc = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
      return sig === calc;
    } catch {
      return false;
    }
  }

  return { createPayment, verifyWebhook };
};
