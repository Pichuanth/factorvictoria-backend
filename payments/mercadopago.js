// payments/mercadopago.js
module.exports = (env) => {
  const token = env.MP_ACCESS_TOKEN;

  async function createPayment({ orderId, amount, concept, email, returnUrl, webhookUrl }) {
    const body = {
      items: [{ title: concept, quantity: 1, unit_price: Number(amount), currency_id: "CLP" }],
      metadata: { orderId },
      back_urls: { success: returnUrl, pending: returnUrl, failure: returnUrl },
      auto_return: "approved",
      notification_url: webhookUrl,
      payer: { email },
    };

    const r = await fetch("https://api.mercadopago.com/checkout/preferences", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`MP ${r.status}: ${JSON.stringify(data)}`);

    return { providerId: data.id, redirectUrl: data.init_point || data.sandbox_init_point };
  }

  function verifyWebhook() {
    // Si luego quieres validar firma: aquí
    return true;
  }

  return { createPayment, verifyWebhook };
};
