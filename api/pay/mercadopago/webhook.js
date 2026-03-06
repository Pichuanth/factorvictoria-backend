const cors = require("../../_cors");
const db = require("../../_db");
const { MercadoPagoConfig, Payment } = require("mercadopago");

function planToTier(plan) {
  const p = String(plan || "").toLowerCase();
  if (p === "mensual") return "basic";
  if (p === "trimestral") return "goleador"; // ajusta si tú quieres otro
  if (p === "anual") return "campeon";      // ajusta si tú quieres otro
  if (p === "vitalicio") return "leyenda";
  return "basic";
}

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  // MP pega GET o POST según evento, aceptamos ambos
  if (req.method !== "GET" && req.method !== "POST") return res.status(405).send("Method not allowed");

  try {
    const accessToken = process.env.MP_ACCESS_TOKEN;
    if (!accessToken) return res.status(500).send("MP_ACCESS_TOKEN missing");

    const client = new MercadoPagoConfig({ accessToken });
    const paymentApi = new Payment(client);

    // MP puede mandar data.id o query params
    const dataId =
      (req.body && req.body.data && req.body.data.id) ||
      (req.query && req.query["data.id"]) ||
      (req.query && req.query.id);

    const type = (req.body && req.body.type) || req.query.type;

    // Si no es payment, igual responde 200 (MP reintenta si no)
    if (!dataId || (type && type !== "payment")) return res.status(200).send("ignored");

    const pay = await paymentApi.get({ id: Number(dataId) });

    // Solo aprobados activan
    if (pay.status !== "approved") return res.status(200).send("not-approved");

    const email = String(pay.metadata?.email || "").toLowerCase();
    const plan = String(pay.metadata?.plan || "").toLowerCase();
    if (!email) return res.status(200).send("no-email");

    const tier = planToTier(plan);

    // activa membresía (ajusta a tu esquema real)
    // idea: upsert por email
    await db.query(
      `
      INSERT INTO memberships (email, plan_id, tier, status, start_at, end_at)
      VALUES ($1, $2, $3, 'active', NOW(), NOW() + INTERVAL '30 days')
      ON CONFLICT (email)
      DO UPDATE SET
        plan_id = EXCLUDED.plan_id,
        tier = EXCLUDED.tier,
        status = 'active',
        start_at = NOW(),
        end_at = NOW() + INTERVAL '30 days'
      `,
      [email, plan, tier]
    );

    return res.status(200).send("ok");
  } catch (e) {
    console.error("MP webhook error", e);
    // responde 200 si quieres evitar reintentos infinitos, pero yo prefiero 500
    return res.status(500).send("error");
  }
};