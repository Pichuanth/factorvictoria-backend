const cors = require("../_cors");
const db = require("../_db");
const { flowPost } = require("./_flow");
const { sendActivationEmail } = require("../_mail");
const { createActivationToken } = require("../_activation");
const plans = require("../_plans");

// GET /api/pay/flow/return?order=... (we set urlReturn to this)
// Flow redirects the user here after payment. We verify payment and show a friendly page.
module.exports = async (req, res) => {
  if (cors(req, res)) return;

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const FRONTEND_URL = process.env.FRONTEND_URL || "https://factorvictoria.com";
  const order = String(req.query?.order || "").trim();
  const tokenFromQuery = String(req.query?.token || "").trim(); // just in case

  const renderHtml = (title, message, extraHtml = "") => {
    const safeTitle = String(title || "FactorVictoria");
    const safeMsg = String(message || "");
    return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${safeTitle}</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Cantarell,Noto Sans,sans-serif;background:#0b1220;color:#e8eefc;margin:0}
    .wrap{max-width:720px;margin:40px auto;padding:24px}
    .card{background:#111a2e;border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:22px;box-shadow:0 8px 30px rgba(0,0,0,.35)}
    a.btn{display:inline-block;margin-top:14px;background:#e6c464;color:#111;border-radius:12px;padding:10px 14px;text-decoration:none;font-weight:700}
    .muted{opacity:.75;font-size:14px;margin-top:10px}
    code{background:rgba(255,255,255,.08);padding:2px 6px;border-radius:8px}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h2 style="margin:0 0 10px 0">${safeTitle}</h2>
      <div>${safeMsg}</div>
      ${extraHtml}
      <div class="muted">Si no se redirige automáticamente, usa el botón.</div>
    </div>
  </div>
</body>
</html>`;
  };

  try {
    // 1) Find intent by order (preferred) or token
    let intent = null;

    if (order) {
      const r = await db.query(
        "select commerce_order, plan_id, email, user_id, flow_token, flow_order, status from payment_intents where commerce_order = $1 limit 1",
        [order]
      );
      intent = r?.rows?.[0] || null;
    } else if (tokenFromQuery) {
      const r = await db.query(
        "select commerce_order, plan_id, email, user_id, flow_token, flow_order, status from payment_intents where flow_token = $1 limit 1",
        [tokenFromQuery]
      );
      intent = r?.rows?.[0] || null;
    }

    // 2) If we have a token, ask Flow for real status
    const token = tokenFromQuery || intent?.flow_token || null;
    if (!token) {
      const html = renderHtml(
        "Pago recibido",
        `Recibimos tu retorno de pago, pero falta el <code>token</code> para validar. Vuelve a intentarlo o contáctanos.`
      );
      return res.status(200).setHeader("Content-Type", "text/html; charset=utf-8").send(html);
    }

    const statusData = await flowPost("/payment/getStatus", { token });
    const flowStatus = Number(statusData?.status);
    const commerceOrder = statusData?.commerceOrder || intent?.commerce_order || order || "";
    const flowOrder = statusData?.flowOrder || intent?.flow_order || null;

    // Upsert basic status (best-effort)
    try {
      await db.query(
        `insert into payment_intents (commerce_order, plan_id, email, user_id, flow_token, flow_order, status)
         values ($1,$2,$3,$4,$5,$6,$7)
         on conflict (commerce_order) do update set
           plan_id = coalesce(excluded.plan_id, payment_intents.plan_id),
           email = coalesce(excluded.email, payment_intents.email),
           user_id = coalesce(excluded.user_id, payment_intents.user_id),
           flow_token = coalesce(excluded.flow_token, payment_intents.flow_token),
           flow_order = coalesce(excluded.flow_order, payment_intents.flow_order),
           status = excluded.status,
           updated_at = now()`,
        [
          commerceOrder,
          intent?.plan_id || null,
          intent?.email || null,
          intent?.user_id || null,
          token,
          flowOrder,
          String(flowStatus),
        ]
      );
    } catch (e) {
      console.warn("[FLOW_RETURN] could not persist status:", e?.message || e);
    }

    if (flowStatus !== 2) {
      // Not paid
      const msg = `El pago no quedó como <b>PAGADO</b> todavía (status: <code>${flowStatus}</code>). Si recién pagaste, espera 30–60s y vuelve a cargar.`;
      const extra = `<a class="btn" href="${FRONTEND_URL}/checkout?plan=${encodeURIComponent(
        intent?.plan_id || "mensual"
      )}">Volver al checkout</a>`;
      const html = renderHtml("Pago pendiente", msg, extra);
      return res.status(200).setHeader("Content-Type", "text/html; charset=utf-8").send(html);
    }

    // 3) Activate membership (idempotent)
    const email = intent?.email || statusData?.payer || null; // payer not always present
    const planId = intent?.plan_id || null;

    if (!email || !planId) {
      const html = renderHtml(
        "Pago confirmado",
        `Tu pago está confirmado, pero no pudimos resolver <code>email</code> o <code>plan</code> para activar automáticamente. Escríbenos con tu comprobante.`,
        `<div class="muted">order: <code>${String(commerceOrder)}</code></div>`
      );
      return res.status(200).setHeader("Content-Type", "text/html; charset=utf-8").send(html);
    }

    // Compute active_until
    const plan = plans?.[planId];
    const days = Number(plan?.days || 30);
    const now = new Date();
    const activeUntil = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

    // Upsert membership
    await db.query(
      `insert into memberships (email, tier, plan_id, status, active_until, cancel_at_period_end, created_at, updated_at)
       values ($1,'pro',$2,'active',$3,false,now(),now())
       on conflict (email) do update set
         tier='pro',
         plan_id=excluded.plan_id,
         status='active',
         active_until=excluded.active_until,
         cancel_at_period_end=false,
         updated_at=now()`,
      [email, planId, activeUntil.toISOString()]
    );

    // Activation email (best-effort, idempotent enough)
    try {
      const tokenAct = await createActivationToken({ email });
      const link = `${FRONTEND_URL}/activate?token=${encodeURIComponent(tokenAct)}`;
      await sendActivationEmail(email, link);
    } catch (e) {
      console.warn("[FLOW_RETURN] could not send activation email:", e?.message || e);
    }

    const okMsg = `✅ Pago confirmado y membresía activada para <b>${email}</b> (${planId}).`;
    const extra = `<a class="btn" href="${FRONTEND_URL}/login">Ir a iniciar sesión</a>`;
    const html = renderHtml("Pago exitoso", okMsg, extra);
    return res.status(200).setHeader("Content-Type", "text/html; charset=utf-8").send(html);
  } catch (err) {
    console.error("[FLOW_RETURN] error:", err);
    const html = `Error al procesar retorno de Flow: ${String(err?.message || err)}`;
    return res.status(500).json({ error: "flow return failed", detail: html });
  }
};
