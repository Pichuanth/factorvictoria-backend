const cors = require("../../_cors");
const db = require("../../_db");
const { MercadoPagoConfig, Payment, MerchantOrder } = require("mercadopago");

function planToTier(planId) {
  const p = String(planId || "").toLowerCase();
  if (p === "mensual") return "basic";
  if (p === "trimestral") return "goleador";
  if (p === "anual") return "campeon";
  if (p === "vitalicio") return "leyenda";
  return null;
}

function planDays(planId) {
  const p = String(planId || "").toLowerCase();
  if (p === "mensual") return 30;
  if (p === "trimestral") return 120;
  if (p === "anual") return 365;
  if (p === "vitalicio") return null;
  return 30;
}

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== "POST" && req.method !== "GET") {
    return res.status(405).send("Method not allowed");
  }

  try {
    const accessToken = process.env.MP_ACCESS_TOKEN;
    if (!accessToken) {
      return res.status(500).send("MP_ACCESS_TOKEN missing");
    }

    const client = new MercadoPagoConfig({ accessToken });
    const paymentApi = new Payment(client);
    const merchantOrderApi = new MerchantOrder(client);

    const topic =
      req.query.topic ||
      req.body?.type ||
      req.body?.topic ||
      req.query.type;

    const resourceId =
      req.query.id ||
      req.query["data.id"] ||
      req.body?.data?.id ||
      req.body?.id;

    if (!topic || !resourceId) {
      return res.status(200).send("ignored");
    }

    let payment = null;

    if (topic === "payment") {
      payment = await paymentApi.get({ id: Number(resourceId) });
    } else if (topic === "merchant_order") {
      const order = await merchantOrderApi.get({ merchantOrderId: Number(resourceId) });

      const payments = order?.payments || order?.response?.payments || [];
      const approvedOrAny = payments.find(p => p.status === "approved") || payments[0];

      if (!approvedOrAny?.id) {
        return res.status(200).send("merchant_order without payment");
      }

      payment = await paymentApi.get({ id: Number(approvedOrAny.id) });
    } else {
      return res.status(200).send("ignored");
    }

    const pay = payment?.response || payment;

    if (!pay || pay.status !== "approved") {
      return res.status(200).send("not-approved");
    }

    const email = String(pay.metadata?.email || pay.payer?.email || "").toLowerCase();
    const planId = String(pay.metadata?.planId || pay.metadata?.plan || "").toLowerCase();

    if (!email || !planId) {
      return res.status(200).send("missing-email-or-plan");
    }

    const tier = planToTier(planId);
    const days = planDays(planId);

    if (!tier) {
      return res.status(200).send("invalid-plan");
    }

    if (days === null) {
      await db.query(
        `
        INSERT INTO memberships (email, plan_id, tier, status, start_at, end_at, cancel_at_period_end)
        VALUES ($1, $2, $3, 'active', NOW(), NULL, false)
        ON CONFLICT (email)
        DO UPDATE SET
          plan_id = EXCLUDED.plan_id,
          tier = EXCLUDED.tier,
          status = 'active',
          start_at = NOW(),
          end_at = NULL,
          cancel_at_period_end = false
        `,
        [email, planId, tier]
      );
    } else {
      await db.query(
        `
        INSERT INTO memberships (email, plan_id, tier, status, start_at, end_at, cancel_at_period_end)
        VALUES ($1, $2, $3, 'active', NOW(), NOW() + ($4 || ' days')::interval, false)
        ON CONFLICT (email)
        DO UPDATE SET
          plan_id = EXCLUDED.plan_id,
          tier = EXCLUDED.tier,
          status = 'active',
          start_at = NOW(),
          end_at = NOW() + ($4 || ' days')::interval,
          cancel_at_period_end = false
        `,
        [email, planId, tier, String(days)]
      );
    }

    return res.status(200).send("ok");
  } catch (err) {
    console.error("MP webhook error", {
      message: err.message,
      error: err.error,
      status: err.status,
      cause: err.cause,
    });
    return res.status(500).send("error");
  }
};