const cors = require("../_cors");
const db = require("../_db");
const qs = require("querystring");
const { flowPost } = require("./_flow");

/**
 * Flow confirmUrl handler (server-to-server).
 * Important: Flow expects HTTP 200 quickly. We respond 200 ASAP and do best-effort processing.
 */
function readRawBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
  });
}

function pick(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] != null && obj[k] !== "") return obj[k];
  }
  return null;
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function paidHintFromParams(params) {
  const v = pick(params, ["status", "paymentStatus", "payment_status", "state", "result", "success"]);
  if (v == null) return false;
  const s = String(v).trim().toLowerCase();
  if (s === "paid" || s === "success" || s === "ok" || s === "approved" || s === "true" || s === "1" || s === "2") return true;
  return false;
}

async function getParams(req) {
  const q = req.query || {};
  if (Object.keys(q).length) return q;
  const raw = await readRawBody(req);
  const body = qs.parse(raw);
  return body || {};
}

async function activateMembership({ email, planId, commerceOrder }) {
  const now = new Date().toISOString();
  await db.query(
    `
    INSERT INTO memberships (email, plan, status, activated_at, last_order)
    VALUES ($1, $2, 'active', $3, $4)
    ON CONFLICT (lower(email))
    DO UPDATE SET plan = EXCLUDED.plan, status='active', activated_at=EXCLUDED.activated_at, last_order=EXCLUDED.last_order
    `,
    [normalizeEmail(email), planId || null, now, commerceOrder || null]
  );
}

module.exports = async (req, res) => {
  if (cors(req, res)) return;

  // Always acknowledge to Flow (avoid retries + "no recibimos respuesta adecuada")
  res.status(200).send("OK");

  try {
    const params = await getParams(req);
    const token = pick(params, ["token", "flowToken", "flow_token"]);
    const commerceOrder = pick(params, ["order", "commerceOrder", "commerce_order"]);
    const paidHint = paidHintFromParams(params);

    if (!token && !commerceOrder) {
      console.warn("[FLOW_CONFIRM] missing token/order", params);
      return;
    }

    // Find intent by order first; fallback by token.
    let intent = null;
    if (commerceOrder) {
      const r = await db.query(
        "SELECT * FROM payment_intents WHERE commerce_order=$1 ORDER BY created_at DESC LIMIT 1",
        [String(commerceOrder)]
      );
      intent = r.rows[0] || null;
    }
    if (!intent && token) {
      const r = await db.query(
        "SELECT * FROM payment_intents WHERE flow_token=$1 ORDER BY created_at DESC LIMIT 1",
        [String(token)]
      );
      intent = r.rows[0] || null;
    }

    const email = intent?.email || normalizeEmail(pick(params, ["email", "payerEmail", "userEmail"]));
    const planId = intent?.plan || intent?.planid || intent?.plan_id || pick(params, ["planId", "plan", "plan_id"]) || null;

    let paid = false;
    let flowStatus = null;

    // If confirm includes a trustworthy paid hint, use it; otherwise query Flow.
    if (paidHint) {
      paid = true;
    } else if (token) {
      try {
        flowStatus = await flowPost("/payment/getStatus", { token: String(token) });
        const st = String(flowStatus?.status ?? "").trim();
        paid = st === "2" || String(flowStatus?.paymentStatus ?? "") === "2";
      } catch (e) {
        console.error("[FLOW_CONFIRM] getStatus error:", e?.message || e);
        paid = false;
      }
    }

    // Update intent
    if (intent) {
      await db.query(
        `
        UPDATE payment_intents
        SET status=$1, raw_confirm=COALESCE(raw_confirm,'{}'::jsonb) || $2::jsonb, updated_at=NOW()
        WHERE id=$3
        `,
        [
          paid ? "paid" : "confirm_failed",
          JSON.stringify({ at: new Date().toISOString(), source: "confirm", params, flowStatus }),
          intent.id,
        ]
      );
    }

    if (paid && email) {
      await activateMembership({ email, planId, commerceOrder: commerceOrder || intent?.commerce_order });
      console.log("[FLOW_CONFIRM] activated membership", { email, planId, commerceOrder });
    } else {
      console.warn("[FLOW_CONFIRM] not paid or missing email", { paid, email, commerceOrder });
    }
  } catch (err) {
    console.error("[FLOW_CONFIRM] handler error:", err);
  }
};
