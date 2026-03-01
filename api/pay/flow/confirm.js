// backend/api/pay/flow/confirm.js
const cors = require("../../_cors");
const db = require("../../_db");
const { flowPost, normalizeTestMode } = require("./_flow");
const qs = require("querystring");

const crypto = require("crypto");

async function sendSetPasswordLinkEmail(email) {
  // Best effort: if anything fails, do not break Flow confirm.
  try {
    const apiKey = process.env.RESEND_API_KEY;
    const from = process.env.EMAIL_FROM || process.env.RESEND_FROM || "";
    const front = (process.env.FRONTEND_URL || "").replace(/\/+$/, "");

    if (!apiKey || !from || !front) {
      console.log("[FLOW_CONFIRM] password link email skipped: missing RESEND_API_KEY / EMAIL_FROM / FRONTEND_URL");
      return;
    }

    // 24h token
    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    // Persist token (table must exist)
    try {
      await db.query(
        `insert into password_set_tokens (email, token, expires_at) values ($1,$2,$3)`,
        [email, token, expiresAt.toISOString()]
      );
    } catch (e) {
      console.log("[FLOW_CONFIRM] password token insert skipped/error:", e?.message || e);
      return;
    }

    const link = `${front}/set-password?token=${encodeURIComponent(token)}`;

    let ResendCtor = null;
    try {
      ({ Resend: ResendCtor } = require("resend"));
    } catch (e) {
      console.log("[FLOW_CONFIRM] resend module missing. Install 'resend' in backend.");
      return;
    }

    const resend = new ResendCtor(apiKey);

    await resend.emails.send({
      from,
      to: email,
      subject: "Crea tu contraseña - Factor Victoria",
      html: `
        <div style="font-family:Arial,sans-serif;line-height:1.4">
          <h2>Pago confirmado ✅</h2>
          <p>Ya tienes acceso a Factor Victoria con tu correo.</p>
          <p><strong>Opcional:</strong> crea una contraseña para entrar más rápido:</p>
          <p><a href="${link}">${link}</a></p>
          <p style="color:#666;font-size:12px">Este link expira en 24 horas.</p>
        </div>
      `,
    });

    console.log("[FLOW_CONFIRM] password link email sent", { email });
  } catch (e) {
    console.log("[FLOW_CONFIRM] password link email error:", e?.message || e);
  }
}

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
      // Optional: send email to create/set password
      await sendSetPasswordLinkEmail(email);
      console.log("[FLOW_CONFIRM] paid ✅", { email, order, plan });
    } else {
      console.log("[FLOW_CONFIRM] not paid", { order });
    }
  } catch (e) {
    console.log("[FLOW_CONFIRM] unexpected error:", e?.message || e);
  }
};