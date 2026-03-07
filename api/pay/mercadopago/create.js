const cors = require("../../_cors");
const { MercadoPagoConfig, Preference } = require("mercadopago");

function deriveNameParts(email = "") {
  const local = String(email || "").split("@")[0] || "cliente";
  const cleaned = local
    .replace(/[._\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const parts = cleaned ? cleaned.split(" ") : ["Cliente"];
  const first = (parts[0] || "Cliente").slice(0, 40);
  const last = (parts.slice(1).join(" ") || "Factor Victoria").slice(0, 40);

  return { first, last };
}

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const accessToken = process.env.MP_ACCESS_TOKEN;
    if (!accessToken) {
      return res.status(500).json({ error: "MP_ACCESS_TOKEN missing" });
    }

    const client = new MercadoPagoConfig({ accessToken });
    const preference = new Preference(client);

    const { email, plan, planId, firstName, lastName } = req.body || {};
    const finalPlan = String(planId || plan || "").trim().toLowerCase();
    const finalEmail = String(email || "").trim().toLowerCase();

    if (!finalEmail || !finalPlan) {
      return res.status(400).json({ error: "Missing email/plan" });
    }

    const prices = {
      mensual: 1000,
      trimestral: 44990,
      anual: 99990,
      vitalicio: 249990,
    };

    const titles = {
      mensual: "Inicio (Mensual)",
      trimestral: "Goleador",
      anual: "Campeón",
      vitalicio: "Leyenda",
    };

    if (!prices[finalPlan]) {
      return res.status(400).json({ error: "Invalid plan" });
    }

    const FRONT = (process.env.FRONT_URL || "https://factorvictoria.com").replace(/\/$/, "");
    const BACK = (process.env.BACK_URL || "https://factorvictoria-backend.vercel.app").replace(/\/$/, "");
    const derived = deriveNameParts(finalEmail);
    const payerFirstName = String(firstName || "").trim() || derived.first;
    const payerLastName = String(lastName || "").trim() || derived.last;

    const prefBody = {
      items: [
        {
          id: finalPlan,
          title: `Factor Victoria - ${titles[finalPlan] || finalPlan}`,
          description: `Suscripción ${titles[finalPlan] || finalPlan} de Factor Victoria`,
          category_id: "subscriptions",
          quantity: 1,
          currency_id: "CLP",
          unit_price: Number(prices[finalPlan]),
        },
      ],

      payer: {
        email: finalEmail,
        name: payerFirstName,
        surname: payerLastName,
      },

      metadata: {
        email: finalEmail,
        planId: finalPlan,
        source: "factorvictoria-web",
      },

      external_reference: `${finalEmail}|${finalPlan}`,

      back_urls: {
        success: `${FRONT}/login?mp=success`,
        pending: `${FRONT}/login?mp=pending`,
        failure: `${FRONT}/login?mp=failure`,
      },

      auto_return: "approved",
      notification_url: `${BACK}/api/pay/mercadopago/webhook`,
      statement_descriptor: "FACTVICTORIA",
    };

    console.log("MP create preference request", {
      email: finalEmail,
      planId: finalPlan,
      amount: prices[finalPlan],
      payer: prefBody.payer,
      notification_url: prefBody.notification_url,
      back_urls: prefBody.back_urls,
      external_reference: prefBody.external_reference,
    });

    const result = await preference.create({ body: prefBody });

    console.log("MP create preference OK", {
      id: result?.id,
      init_point: result?.init_point,
      sandbox_init_point: result?.sandbox_init_point || null,
    });

    return res.status(200).json({
      ok: true,
      id: result.id,
      init_point: result.init_point,
      sandbox_init_point: result.sandbox_init_point || null,
      debug: {
        email: finalEmail,
        planId: finalPlan,
        amount: prices[finalPlan],
        payer: prefBody.payer,
      },
    });
  } catch (e) {
    console.error("MP create error", {
      message: e?.message,
      cause: e?.cause,
      stack: e?.stack,
    });
    return res.status(500).json({
      error: "MP create failed",
      message: e?.message || null,
      cause: e?.cause || null,
    });
  }
};
