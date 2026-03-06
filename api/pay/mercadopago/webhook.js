const cors = require("../../_cors");
const db = require("../../_db");
const { Resend } = require("resend");
const { createActivationToken } = require("../../_activation");
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

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolvePaymentFromMerchantOrder(merchantOrderApi, paymentApi, resourceId) {
  let lastOrder = null;

  for (let attempt = 1; attempt <= 4; attempt++) {
    const order = await merchantOrderApi.get({ merchantOrderId: Number(resourceId) });
    const ord = order?.response || order;
    lastOrder = ord;
    const payments = Array.isArray(ord?.payments) ? ord.payments : [];

    console.log("MP merchant_order fetched", {
      attempt,
      id: ord?.id,
      order_status: ord?.order_status,
      paid_amount: ord?.paid_amount,
      total_amount: ord?.total_amount,
      external_reference: ord?.external_reference,
      preference_id: ord?.preference_id,
      payments,
    });

    const approvedOrAny = payments.find((p) => p?.status === "approved") || payments[0];
    if (approvedOrAny?.id) {
      const payment = await paymentApi.get({ id: Number(approvedOrAny.id) });
      return { payment, order: ord };
    }

    if (attempt < 4) await sleep(1200);
  }

  console.log("MP merchant_order without payments", {
    merchantOrderId: resourceId,
    order_status: lastOrder?.order_status,
    paid_amount: lastOrder?.paid_amount,
    total_amount: lastOrder?.total_amount,
    external_reference: lastOrder?.external_reference,
  });

  return { payment: null, order: lastOrder };
}

async function sendActivationEmail(email) {
  const resendKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM || process.env.EMAIL_FROM;
  const frontendUrl = (process.env.FRONTEND_URL || "https://www.factorvictoria.com").replace(/\/+$/, "");

  if (!resendKey || !from || !email) {
    console.log("MP activation email skipped", {
      email,
      reason: !email ? "missing_email" : !resendKey ? "missing_resend_key" : "missing_resend_from",
    });
    return;
  }

  try {
    const token = await createActivationToken(email);
    const link = `${frontendUrl}/set-password?token=${encodeURIComponent(token)}&email=${encodeURIComponent(email)}`;
    const resend = new Resend(resendKey);

    const result = await resend.emails.send({
      from,
      to: email,
      subject: "Activa tu acceso - Factor Victoria",
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#111">
          <h2 style="margin-bottom:16px">Pago confirmado ✅</h2>
          <p style="font-size:15px;line-height:1.6">
            Tu membresía ya está activa. Para crear tu contraseña y dejar tu acceso listo,
            haz clic en el siguiente botón:
          </p>
          <p style="margin:24px 0">
            <a href="${link}" style="background:#0ea5e9;color:#fff;text-decoration:none;padding:12px 18px;border-radius:8px;display:inline-block;font-weight:700">
              Crear contraseña
            </a>
          </p>
          <p style="font-size:14px;line-height:1.6">Si el botón no abre, copia y pega este link en tu navegador:</p>
          <p style="font-size:13px;word-break:break-all;color:#444">${link}</p>
          <p style="font-size:14px;color:#666;margin-top:20px">Este link expira en 24 horas. Si no fuiste tú, ignora este correo.</p>
        </div>
      `,
    });

    console.log("MP activation email sent", {
      email,
      from,
      id: result?.data?.id || result?.id || null,
      error: result?.error || null,
    });
  } catch (err) {
    console.log("MP activation email error", {
      email,
      from,
      message: err?.message || String(err),
      status: err?.status,
      error: err?.error,
    });
  }
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
      const resolved = await resolvePaymentFromMerchantOrder(merchantOrderApi, paymentApi, resourceId);
      payment = resolved.payment;
      if (!payment) {
        return res.status(200).send("merchant_order without payment");
      }
    } else {
      return res.status(200).send("ignored");
    }

    const pay = payment?.response || payment;

    console.log("MP payment fetched", {
      id: pay?.id,
      status: pay?.status,
      status_detail: pay?.status_detail,
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

    if (!tier) return res.status(200).send("invalid-plan");

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

    await sendActivationEmail(email);

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
