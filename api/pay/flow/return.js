// backend/api/pay/flow/return.js
const cors = require("../../_cors");
const db = require("../../_db");
const { flowPost, normalizeTestMode } = require("./_flow");
const qs = require("querystring");

function safeString(v) {
  if (v === undefined || v === null) return "";
  return String(v);
}

function buildRedirectUrl(frontendUrl, email, paid) {
  const base = (frontendUrl || "").replace(/\/+$/, "");
  const e = encodeURIComponent(email || "");
  return `${base}/login?email=${e}&paid=${paid ? "1" : "0"}`;
}

async function readBody(req) {
  // Vercel Node serverless: body no siempre viene parseado según content-type.
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", () => resolve(""));
  });
}

function parseIncoming(req, rawBody) {
  // Query (Vercel suele exponer req.query, pero fallback a URL)
  const url = req.url || "";
  const queryStr = url.includes("?") ? url.split("?")[1] : "";
  const query = qs.parse(queryStr);

  // Body
  const ct = safeString(req.headers["content-type"]).toLowerCase();
  let body = {};
  if (rawBody) {
    if (ct.includes("application/json")) {
      try {
        body = JSON.parse(rawBody);
      } catch (_) {
        body = {};
      }
    } else if (ct.includes("application/x-www-form-urlencoded")) {
      body = qs.parse(rawBody);
    } else {
      // a veces Flow manda text/plain con key=value
      body = qs.parse(rawBody);
    }
  }

  // Campos posibles
  const order =
    safeString(query.order) ||
    safeString(query.commerceOrder) ||
    safeString(query.commerce_order) ||
    safeString(body.order) ||
    safeString(body.commerceOrder) ||
    safeString(body.commerce_order);

  const token =
    safeString(query.token) ||
    safeString(query.token_ws) ||
    safeString(body.token) ||
    safeString(body.token_ws);

  return { query, body, order, token };
}

async function tryActivateMembership({ email, plan, commerceOrder }) {
  // IMPORTANTE: como no tengo tu esquema exacto de membresías, esto es “best effort”.
  // Si tu sistema ya activa membresía en otro módulo, aquí puedes llamar ese módulo.
  // Para no romper en producción, lo envolvemos en try/catch.
  try {
    if (!email) return;

    // Ejemplo genérico: tabla memberships (ajusta si tu tabla se llama distinto)
    // Si NO existe, caerá al catch y no rompe return/confirm.
    await db.query(
      `
      insert into memberships (email, plan, status, activated_at, last_order)
      values ($1, $2, 'active', now(), $3)
      on conflict (email)
      do update set
        plan = excluded.plan,
        status = 'active',
        activated_at = now(),
        last_order = excluded.last_order
      `,
      [email, plan || "pro", commerceOrder || null]
    );
  } catch (e) {
    console.log("[FLOW_RETURN] membership activate skipped/error:", e?.message || e);
  }
}

module.exports = async (req, res) => {
  // CORS / preflight
  if (cors(req, res)) return;

  // Nunca 405: aceptamos GET/POST/OPTIONS
  if (req.method === "OPTIONS") {
    return res.status(200).send("ok");
  }

  const rawBody = await readBody(req);
  const { order, token } = parseIncoming(req, rawBody);

  const FRONTEND_URL = process.env.FRONTEND_URL || process.env.VITE_FRONTEND_URL || "";
  const testMode = normalizeTestMode(process.env.FLOW_TEST_MODE);

  console.log("[FLOW_RETURN] method=", req.method, "order=", order, "token=", token ? "yes" : "no", "testMode=", testMode);

  // Si no viene order, redirige igual a login con paid=0 (no rompas UX)
  if (!order) {
    const redirect = buildRedirectUrl(FRONTEND_URL, "", false);
    res.writeHead(302, { Location: redirect });
    return res.end();
  }

  // Busca intent en DB
  let intent = null;
  try {
    const r = await db.query(
      `select * from payment_intents where commerce_order = $1 limit 1`,
      [order]
    );
    intent = r.rows?.[0] || null;
  } catch (e) {
    console.log("[FLOW_RETURN] DB read error:", e?.message || e);
  }

  const email = intent?.email || "";
  const plan = intent?.plan || intent?.tier || "pro";

  // Token: preferimos el que llega, si no el guardado
  const flowToken = token || intent?.flow_token || intent?.flowToken || "";

  // Si no hay token, no podemos validar. Igual redirigimos sin crashear.
  if (!flowToken) {
    const redirect = buildRedirectUrl(FRONTEND_URL, email, false);
    res.writeHead(302, { Location: redirect });
    return res.end();
  }

  // Consulta estado a Flow
  let status = null;
  try {
    status = await flowPost("/payment/getStatus", { token: flowToken }, { testMode });
    // status típico trae: status / paymentData / etc (depende API)
    console.log("[FLOW_RETURN] getStatus ok");
  } catch (e) {
    console.log("[FLOW_RETURN] getStatus error:", e?.message || e);
  }

  // Determinar “paid”
  const paid =
    status &&
    (String(status.status).toLowerCase() === "paid" ||
      String(status.status).toLowerCase() === "2" || // por si Flow usa códigos
      String(status.paymentStatus || "").toLowerCase() === "paid");

  // Persistir en DB (best effort)
  try {
    await db.query(
      `
      update payment_intents
      set
        flow_token = coalesce(nullif($2,''), flow_token),
        status = $3,
        raw_flow_status = $4,
        updated_at = now()
      where commerce_order = $1
      `,
      [order, flowToken, paid ? "paid" : "pending", status ? JSON.stringify(status) : null]
    );
  } catch (e) {
    console.log("[FLOW_RETURN] DB update error:", e?.message || e);
  }

  if (paid) {
    await tryActivateMembership({ email, plan, commerceOrder: order });
  }

  // Redirigir siempre al front
  const redirect = buildRedirectUrl(FRONTEND_URL, email, !!paid);
  res.writeHead(302, { Location: redirect });
  return res.end();
};