const cors = require("../../_cors");
const { MercadoPagoConfig, Preference } = require("mercadopago");

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const accessToken = process.env.MP_ACCESS_TOKEN;
    if (!accessToken) return res.status(500).json({ error: "MP_ACCESS_TOKEN missing" });

    const client = new MercadoPagoConfig({ accessToken });
    const preference = new Preference(client);

    const { email, plan, planId } = req.body || {};
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

    if (!prices[finalPlan]) return res.status(400).json({ error: "Invalid plan" });

    const FRONT = (process.env.FRONT_URL || "https://factorvictoria.com").replace(/\/$/, "");
    const BACK = (process.env.BACK_URL || "https://factorvictoria-backend.vercel.app").replace(/\/$/, "");

    const prefBody = {
      items: [
        {
          title: `Factor Victoria - ${titles[finalPlan] || finalPlan}`,
          quantity: 1,
          currency_id: "CLP",
          unit_price: prices[finalPlan],
        },
      ],
      payer: {
        email: finalEmail,
      },
      metadata: {
        email: finalEmail,
        planId: finalPlan,
      },
      external_reference: `${finalEmail}|${finalPlan}`,
      back_urls: {
        success: `${FRONT}/login?mp=success`,
        pending: `${FRONT}/login?mp=pending`,
        failure: `${FRONT}/login?mp=failure`,
      },
      auto_return: "approved",
      notification_url: `${BACK}/api/pay/mercadopago/webhook`,
    };

    const result = await preference.create({ body: prefBody });

    return res.status(200).json({
      ok: true,
      id: result.id,
      init_point: result.init_point,
      sandbox_init_point: result.sandbox_init_point,
    });
  } catch (e) {
    console.error("MP create error", {
      message: e.message,
      error: e.error,
      status: e.status,
      cause: e.cause,
      stack: e.stack,
    });
    return res.status(500).json({ error: "MP create failed" });
  }
};
