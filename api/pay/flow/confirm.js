// backend/api/pay/flow/confirm.js
const cors = require("../../_cors");
const db = require("../../_db");
const { flowPost, normalizeTestMode } = require("./_flow");
const qs = require("querystring");

function safeString(v) {
  if (v === undefined || v === null) return "";
  return String(v);
}

async function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", () => resolve(""));
  });
}

function parseBody(req, rawBody) {
  const ct = safeString(req.headers["content-type"]).toLowerCase();
  if (!rawBody) return {};
  if (ct.includes("application/json")) {
    try {
      return JSON.parse(rawBody);
    } catch (_) {
      return {};
    }
  }
  // Flow suele mandar x-www-form-urlencoded
  if (ct.includes("application/x-www-form-urlencoded")) {
    return qs.parse(rawBody);
  }
  // fallback
  return qs.parse(rawBody);
}

async function tryActivateMembership({ email, plan, commerceOrder }) {
  try {
    if (!email) return;

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
    console.log("[FLOW_CONFIRM] membership activate skipped/error:", e?.message || e);
  }
}

module.exports = async (req, res) => {
  if (cors(req, res)) return;

  if (req.method === "OPTIONS") return res.status(200).send("ok");

  // Aceptamos POST y también GET (por si pruebas manuales)
  if (req.method !== "POST" && req.method !== "GET") {
    // Nunca 405 para Flow: igual respondemos 200 para no gatillar alertas
    console.log("[FLOW_CONFIRM] unexpected method:", req.method);
    return res.status(200).json({ ok: true });
  }

  const testMode = normalizeTestMode(process.env.FLOW_TEST_MODE);

  const rawBody = await readBody(req);
  const body = parseBody(req, rawBody);

  const token =
    safeString(req.query?.token) ||
    safeString(req.query?.token_ws) ||
    safeString(body.token) ||
    safeString(body.token_ws);

  // Responder 200 OK rápido (Flow lo exige). Hacemos la lógica en el mismo request,
  // pero sin demorar respuesta por validaciones pesadas: primero ACK, luego seguimos.
  res.status(200).json({ ok: true });

  // ---- lógica post-ACK ----
  try {
    console.log("[FLOW_CONFIRM] token=", token ? "yes" : "no", "testMode=", testMode);

    if (!token) {
      console.log("[FLOW_CONFIRM] missing token");
      return;
    }

    // Flow getStatus
    let status = null;
    try {
      status = await flowPost("/payment/getStatus", { token }, { testMode });
      console.log("[FLOW_CONFIRM] getStatus ok");
    } catch (e) {
      console.log("[FLOW_CONFIRM] getStatus error:", e?.message || e);
      return;
    }

    const commerceOrder =
      safeString(status?.commerceOrder) ||
      safeString(status?.commerce_order) ||
      safeString(status?.order) ||
      safeString(status?.optional?.commerceOrder);

    const paid =
      status &&
      (String(status.status).toLowerCase() === "paid" ||
        String(status.status).toLowerCase() === "2" ||
        String(status.paymentStatus || "").toLowerCase() === "paid");

    // Lee intent para obtener email/plan
    let intent = null;
    try {
      if (commerceOrder) {
        const r = await db.query(
          `select * from payment_intents where commerce_order = $1 limit 1`,
          [commerceOrder]
        );
        intent = r.rows?.[0] || null;
      } else {
        // fallback: buscar por token si guardaste flow_token antes
        const r = await db.query(
          `select * from payment_intents where flow_token = $1 limit 1`,
          [token]
        );
        intent = r.rows?.[0] || null;
      }
    } catch (e) {
      console.log("[FLOW_CONFIRM] DB read error:", e?.message || e);
    }

    const email = intent?.email || "";
    const plan = intent?.plan || intent?.tier || "pro";
    const order = commerceOrder || intent?.commerce_order || "";

    // Guardar token + estado
    try {
      if (order) {
        await db.query(
          `
          update payment_intents
          set
            flow_token = $2,
            status = $3,
            raw_flow_status = $4,
            updated_at = now()
          where commerce_order = $1
          `,
          [order, token, paid ? "paid" : "pending", JSON.stringify(status)]
        );
      } else if (intent?.id) {
        await db.query(
          `
          update payment_intents
          set
            flow_token = $2,
            status = $3,
            raw_flow_status = $4,
            updated_at = now()
          where id = $1
          `,
          [intent.id, token, paid ? "paid" : "pending", JSON.stringify(status)]
        );
      }
    } catch (e) {
      console.log("[FLOW_CONFIRM] DB update error:", e?.message || e);
    }

    if (paid) {
      await tryActivateMembership({ email, plan, commerceOrder: order });
      console.log("[FLOW_CONFIRM] paid ✅", { email, order, plan });
    } else {
      console.log("[FLOW_CONFIRM] not paid", { order });
    }
  } catch (e) {
    console.log("[FLOW_CONFIRM] unexpected error:", e?.message || e);
  }
};