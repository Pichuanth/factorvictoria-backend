// vendors/shopify.js
module.exports = (env) => {
  const shop = env.SHOPIFY_SHOP;
  const token = env.SHOPIFY_TOKEN;

  async function createDraftOrder({ email, shipping, lineItems }) {
    if (!shop || !token) return;
    const body = {
      draft_order: {
        email,
        shipping_address: {
          name: shipping?.name || email,
          phone: shipping?.phone || null,
          address1: shipping?.address1 || "",
          address2: shipping?.address2 || "",
          city: shipping?.city || "",
          province: shipping?.region || "",
          zip: shipping?.zip || "",
          country: "CL",
        },
        line_items: lineItems.map((it) => ({
          title: it.title || "Regalo Membresía",
          quantity: it.qty || 1,
          sku: it.sku,
        })),
        note: "Regalo por suscripción Factor Victoria",
      },
    };

    const r = await fetch(`https://${shop}/admin/api/2024-04/draft_orders.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Shopify ${r.status}: ${JSON.stringify(data)}`);
    return data;
  }

  return { createDraftOrder };
};
