const cors = require("../_cors");
const db = require("../_db");
const qs = require("querystring");
const { flowPost } = require("./_flow");

/**
 * Flow returnUrl handler.
 * Flow can hit this endpoint via GET/POST depending on payment method.
 * We never want 405 here: always redirect user back to the frontend.
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
  // Different Flow integrations may send status-like fields.
  const v = pick(params, ["status", "paymentStatus", "payment_status", "state", "result", "success"]);
  if (v == null) return false;
  const s = String(v).trim().toLowerCase();
  // Common meanings:
  // - "2" often used as "paid" in some gateways (keep as hint, not authoritative)
  if (s === "paid" || s === "success" || s === "ok" || s === "approved" || s === "true" || s === "1" || s === "2") return true;
  return false;
}

async function getParams(req) {
  // Prefer query params, but Flow POSTs application/x-www-form-urlencoded too.
  const q = req.query || {};
  if (Object.keys(q).length) return q;

  const raw = await readRawBody(req);
  const body = qs.parse(raw);
  return body || {};
}

async function activateMembership({ email, planId, status, commerceOrder }) {
  // Keep this aligned with your auth/membership checks: we upsert "memberships".
  // If your schema differs, adjust here.
  const now = new Date().toISOString();
  await db.query(
    `
    INSERT INTO memberships (email, plan, status, activated_at, last_order)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (lower(email))
    DO UPDATE SET plan = EXCLUDED.plan, status = EXCLUDED.status, activated_at = EXCLUDED.activated_at, last_order = EXCLUDED.last_order
    `,
    [normalizeEmail(email), planId || null, status || "active", now, commerceOrder || null]
  );
}

function buildRedirect(frontendUrl, email, paid) {
  const e = encodeURIComponent(email || "");
  const p = paid ? "1" : "0";
  return `${frontendUrl}/login?email=${e}&paid=${p}`;
}

module.exports = async (req, res) => {
  if (cors(req, res)) return;

  // Always handle GET/POST/OPTIONS (CORS already did OPTIONS).
  const FRONTEND_URL = process.env.FRONTEND_URL || "https://www.factorvictoria.com";

  try {
    const params = await getParams(req);
    const token = pick(params, ["token", "flowToken", "flow_token"]);
    const commerceOrder = pick(params, ["order", "commerceOrder", "commerce_order"]);
    const paidHint = paidHintFromParams(params);

    // Find the intent to know who to activate.
    let intent = null;
    if (commerceOrder) {
      const r = await db.query(
        "SELECT * FROM payment_intents WHERE commerce_order=$1 ORDER BY created_at DESC LIMIT 1",
        [String(commerceOrder)]
      );
      intent = r.rows[0] || null;
    }

    let email = intent?.email || pick(params, ["email", "payerEmail", "userEmail"]);
    email = email ? normalizeEmail(email) : "";

    // Best effort: check Flow status when token exists; otherwise rely on hint.
    let paid = false;
    let flowStatus = null;

    if (token) {
      try {
        flowStatus = await flowPost("/payment/getStatus", { token: String(token) });
        const st = String(flowStatus?.status ?? "").trim();
        // Flow usually uses numeric status codes; treat "2" as paid.
        paid = st === "2" || String(flowStatus?.paymentStatus ?? "") === "2";
      } catch (e) {
        // If Flow status lookup fails, don't block user; use hint only.
        paid = !!paidHint;
      }
    } else {
      paid = !!paidHint;
    }

    // Update intent record for observability
    if (intent) {
      await db.query(
        `
        UPDATE payment_intents
        SET status=$1, raw_confirm=COALESCE(raw_confirm,'{}'::jsonb) || $2::jsonb, updated_at=NOW()
        WHERE id=$3
        `,
        [
          paid ? "paid" : "return_received",
          JSON.stringify({ at: new Date().toISOString(), source: "return", params, flowStatus }),
          intent.id,
        ]
      );
    }

    // If we are confident it's paid, activate immediately (makes UX instant even if confirm webhook fails).
    if (paid && email) {
      const planId = intent?.plan || intent?.planid || intent?.plan_id || pick(params, ["planId", "plan", "plan_id"]);
      await activateMembership({ email, planId, status: "active", commerceOrder: commerceOrder || intent?.commerce_order });
    }

    res.redirect(302, buildRedirect(FRONTEND_URL, email, paid));
  } catch (err) {
    console.error("[FLOW_RETURN] error:", err);
    // Fail open: redirect without paid flag to avoid white screens.
    res.redirect(302, `${FRONTEND_URL}/login?email=&paid=0`);
  }
};
