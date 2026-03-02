const cors = require("../../_cors");
const db = require("../../_db");
const qs = require("querystring");

// POST /api/pay/flow/return  (Flow redirect/POST after payment)
// We accept both POST and GET to avoid 500 if someone opens it in browser.
module.exports = async (req, res) => {
  if (cors(req, res)) return;

  try {
    const method = (req.method || "GET").toUpperCase();

    // Flow normally POSTs x-www-form-urlencoded with token
    let token =
      (req.query && req.query.token) ||
      (req.body && (req.body.token || req.body.TOKEN)) ||
      null;

    // If Vercel didn't parse body, try manual parse
    if (!token && method === "POST") {
      await new Promise((resolve) => {
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", () => {
          if (raw) {
            const parsed = qs.parse(raw);
            token = parsed.token || parsed.TOKEN || null;
          }
          resolve();
        });
      });
    }

    // If user opens in browser, just show OK (Flow will still hit confirm via webhook/notify)
    if (!token) {
      return res.status(200).send("ok");
    }

    // Save minimal return receipt (idempotent)
    // We don't assume schema; confirm.js will do final activation.
    try {
      await db.query(
        `insert into payment_intents (flow_token, status, updated_at)
         values ($1, 'returned', now())
         on conflict (flow_token) do update set status='returned', updated_at=now()`,
        [token]
      );
    } catch (e) {
      // ignore if table/constraint differs
    }

    // Redirect user to frontend login with paid=0 (wait confirm) - keep email placeholder on FE
    const FRONTEND_URL = process.env.FRONTEND_URL || "https://www.factorvictoria.com";
    return res.redirect(302, `${FRONTEND_URL}/login?email=&paid=0`);
  } catch (err) {
    console.error("[FLOW_RETURN] error", err);
    return res.status(200).send("ok"); // never break Flow redirect
  }
};
