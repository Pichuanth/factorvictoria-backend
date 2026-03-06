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

function getTopic(req) {
  return req.query.topic || req.query.type || req.body?.topic || req.body?.type || "";
}

function getResourceId(req) {
  const direct = req.query["data.id"] || req.query.id || req.body?.data?.id || req.body?.id || null;
  if (direct) return direct;

  const resource = req.body?.resource;
  if (typeof resource === "string") {
    const m = resource.match(/\/(\d+)(?:\?|$)/);
    if (m?.[1]) return m[1];
  }

  return null;
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

    const topic = getTopic(req);
    const resourceId = getResourceId(req);

    console.log("MP webhook IN", {
      method: req.method,
      query: req.query,
      body: req.body,
      topic,
      resourceId,
    });

    if (!topic || !resourceId) {
      return res.status(200).send("ignored");
    }

    let payment = null;

    if (topic === "payment") {
      payment = await paymentApi.get({ id: Number(resourceId) });
    } else if (topic === "merchant_order") {
      const order = await merchantOrderApi.get({ merchantOrderId: Number(resourceId) });
      const ord = order?.response || order;
      const payments = Array.isArray(ord?.payments) ? ord.payments : [];

      console.log("MP merchant_order fetched", {
        id: ord?.id,
        order_status: ord?.order_status,
        paid_amount: ord?.paid_amount,
        total_amount: ord?.total_amount,
        external_reference: ord?.external_reference,
        preference_id: ord?.preference_id,
        payments,
      });

      const approvedOrAny = payments.find((p) => p?.status === "approved") || payments[0];

      if (!approvedOrAny?.id) {
        console.log("MP merchant_order without payments", {
          merchantOrderId: resourceId,
          order_status: ord?.order_status,
          paid_amount: ord?.paid_amount,
          total_amount: ord?.total_amount,
          external_reference: ord?.external_reference,
        });
        return res.status(200).send("merchant_order without payment");
      }

      payment = await paymentApi.get({ id: Number(approvedOrAny.id) });
    } else {
      return res.status(200).send("ignored");
    }

    const pay = payment?.response || payment;

    console.log("MP payment fetched", {
      id: pay?.id,
      status: pay?.status,
      status_detail: pay?.status_detail,
      transaction_amount: pay?.transaction_amount,
      external_reference: pay?.external_reference,
      metadata: pay?.metadata,
      payer_email: pay?.payer?.email,
    });

    if (!pay || pay.status !== "approved") {
      return res.status(200).send("not-approved");
    }

    let email = String(pay.metadata?.email || pay.payer?.email || "").trim().toLowerCase();
    let planId = String(pay.metadata?.planId || pay.metadata?.plan || "").trim().toLowerCase();

    if ((!email || !planId) && pay.external_reference) {
      const [extEmail, extPlan] = String(pay.external_reference).split("|");
      if (!email && extEmail) email = String(extEmail).trim().toLowerCase();
      if (!planId && extPlan) planId = String(extPlan).trim().toLowerCase();
    }

    if (!email || !planId) {
      console.log("MP webhook missing email/plan", {
        paymentId: pay?.id,
        email,
        planId,
        external_reference: pay?.external_reference,
        metadata: pay?.metadata,
      });
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

    console.log("MP membership activated", {
      email,
      planId,
      tier,
      paymentId: pay?.id,
    });

    return res.status(200).send("ok");
  } catch (err) {
    console.error("MP webhook error", {
      message: err.message,
      error: err.error,
      status: err.status,
      cause: err.cause,
      stack: err.stack,
    });

    return res.status(200).send("error");
  }
};
