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

async function sendActivationEmail(email) {
  const resendKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM || process.env.EMAIL_FROM;
  const frontendUrl = (process.env.FRONTEND_URL || "https://factorvictoria.com").replace(/\/+$/, "");

  if (!resendKey || !from) {
    console.log("MP activation email skipped", {
      email,
      reason: !resendKey ? "missing_resend_key" : "missing_resend_from",
    });
    return;
  }

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

    const topic = req.query.topic || req.body?.type || req.body?.topic || req.query.type;
    const resourceId = req.query.id || req.query["data.id"] || req.body?.data?.id || req.body?.id;

    if (!topic || !resourceId) {
      return res.status(200).send("ignored");
    }

    let payment = null;

    if (topic === "payment") {
      payment = await paymentApi.get({ id: Number(resourceId) });
    } else if (topic === "merchant_order") {
      const order = await merchantOrderApi.get({ merchantOrderId: Number(resourceId) });
      const ord = order?.response || order;
      const payments = ord?.payments || [];
      const approvedOrAny = payments.find((p) => p.status === "approved") || payments[0];

      if (!approvedOrAny?.id) {
        console.log("MP merchant_order without payments", {
          merchantOrderId: String(resourceId),
          order_status: ord?.order_status,
        });
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

    const email = String(pay.metadata?.email || pay.payer?.email || "").trim().toLowerCase();
    const planId = String(pay.metadata?.planId || pay.metadata?.plan || "").trim().toLowerCase();
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

    console.log("MP membership activated", { email, planId, tier, paymentId: pay.id });

    try {
      await sendActivationEmail(email);
    } catch (mailErr) {
      console.error("MP activation email error", {
        email,
        message: mailErr?.message,
        error: mailErr?.error,
        status: mailErr?.status,
      });
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
