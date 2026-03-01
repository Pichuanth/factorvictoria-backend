const cors = require("../../_cors");
const db = require("../../_db");
const plans = require("../../_plans");
const { createActivationToken } = require("../../_activation");
const { sendActivationEmail } = require("../../_mail");
const { flowPost } = require("./_flow");

function isTruthy(v) {
  const s = String(v ?? "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "y";
}

function parseCommerceOrder(co) {
  // Formato: FV|<planId>|<email>|<ts>
  try {
    const s = String(co || "");
    const parts = s.split("|");
    if (parts.length >= 3 && parts[0] === "FV") {
      return { planId: parts[1] || null, email: parts[2] || null };
    }
  } catch (e) {}
  return { planId: null, email: null };
}

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const FRONTEND_URL = process.env.FRONTEND_URL || "https://factorvictoria.com";
  const wantJson = isTruthy(req.query.json);

  const commerceOrder = String(req.query.order || "").trim();
  if (!commerceOrder) {
    return wantJson
      ? res.status(400).json({ ok: false, error: "Missing order" })
      : res.status(400).send("Missing order");
  }

  try {
    // 1) Buscar intent (plan/email)
    let intent;
    try {
      const r = await db.query(
        "select plan_id, email, user_id, status from payment_intents where commerce_order = $1 limit 1",
        [commerceOrder]
      );
      intent = r.rows?.[0];
    } catch (e) {}

    const parsed = parseCommerceOrder(commerceOrder);
    const planId = intent?.plan_id || parsed.planId;
    const emailRaw = intent?.email || parsed.email || null;
    const email = emailRaw ? String(emailRaw).trim().toLowerCase() : null;
    const userId = intent?.user_id || null;

    // 2) Consultar estado en Flow
    // Flow devuelve status=2 cuando está pagado
    const statusData = await flowPost("/payment/getStatus", { commerceOrder });
    const status = Number(statusData?.status);
    const isPaid = status === 2;

    // Persist best-effort payment row (si tienes tabla payments)
    try {
      await db.query(
        `insert into payments (flow_order, commerce_order, status, raw)
         values ($1,$2,$3,$4)
         on conflict (flow_order) do update set status = excluded.status, raw = excluded.raw`,
        [Number(statusData?.flowOrder || 0), commerceOrder, status || null, statusData]
      );
    } catch (_) {}

    if (!isPaid) {
      // Actualiza intent a "created" (best-effort)
      try {
        await db.query("update payment_intents set status = 'created' where commerce_order = $1", [commerceOrder]);
      } catch (_) {}

      if (wantJson) {
        return res.status(200).json({ ok: true, paid: false, status, commerceOrder });
      }

      // Redirige al front con paid=0
      const to = `${FRONTEND_URL}/checkout?flow=return&paid=0&order=${encodeURIComponent(commerceOrder)}${
        email ? `&email=${encodeURIComponent(email)}` : ""
      }`;
      return res.writeHead(302, { Location: to }).end();
    }

    // 3) Si está pagado, activar membresía (idempotente)
    if (planId && plans[planId] && email) {
      const now = new Date();
      const planDays = plans[planId]?.days;
      const end = planDays == null ? null : new Date(now.getTime() + planDays * 24 * 60 * 60 * 1000);

      try {
        await db.query(
          `insert into memberships (email, user_id, plan_id, tier, status, start_at, end_at)
           values ($1,$2,$3,$4,'active',$5,$6)
           on conflict (email) do update set
             user_id = excluded.user_id,
             plan_id = excluded.plan_id,
             tier = excluded.tier,
             status = 'active',
             start_at = excluded.start_at,
             end_at = excluded.end_at`,
          [email, userId, planId, plans[planId].tier, now.toISOString(), end ? end.toISOString() : null]
        );

        await db.query("update payment_intents set status = 'paid' where commerce_order = $1", [commerceOrder]);
      } catch (e) {
        console.error("[FLOW_RETURN] activate membership failed", e);
      }

      // activation link (best-effort)
      let activationLink = "";
      try {
        const actToken = await createActivationToken(email);
        activationLink = `${FRONTEND_URL}/activar?token=${actToken}`;
        await sendActivationEmail({ to: email, activationLink });
      } catch (e2) {
        // no pasa nada
      }

      if (wantJson) {
        return res.status(200).json({ ok: true, paid: true, planId, email, commerceOrder, activationLink });
      }

      const to = `${FRONTEND_URL}/checkout?flow=return&paid=1&order=${encodeURIComponent(commerceOrder)}&email=${encodeURIComponent(
        email
      )}`;
      return res.writeHead(302, { Location: to }).end();
    }

    // Paid pero falta plan/email -> igual devolvemos ok
    if (wantJson) {
      return res.status(200).json({ ok: true, paid: true, status, commerceOrder, email, planId });
    }

    const to = `${FRONTEND_URL}/checkout?flow=return&paid=1&order=${encodeURIComponent(commerceOrder)}${
      email ? `&email=${encodeURIComponent(email)}` : ""
    }`;
    return res.writeHead(302, { Location: to }).end();
  } catch (err) {
    console.error("flow return error:", err);
    if (wantJson) return res.status(500).json({ ok: false, error: "flow return failed" });
    return res.status(500).send("flow return failed");
  }
};
