// backend/api/auth/login.js
const cors = require("../_cors");
const db = require("../_db");
const { hasPassword, verifyPassword } = require("../_activation");

// POST /api/auth/login { email, password }
module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  let body = {};
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  } catch {
    body = {};
  }

  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");

  if (!email) return res.status(400).json({ ok: false, error: "email_required" });

  try {
    // Get latest membership by email
    const q = `
      SELECT email, tier, plan_id AS "planId", status, start_at AS "startAt", end_at AS "endAt"
      FROM memberships
      WHERE lower(email) = lower($1)
      ORDER BY start_at DESC NULLS LAST
      LIMIT 1
    `;
    const { rows } = await db.query(q, [email]);
    const m = rows?.[0] || null;

    const now = new Date();
    const endAt = m?.endAt ? new Date(m.endAt) : null;
    const active = !!m && (
      String(m.status || "").toLowerCase() === "active" ||
      String(m.status || "").toLowerCase() === "paid"
    ) && (!endAt || endAt.getTime() > now.getTime());

    if (!active) return res.status(403).json({ ok: false, error: "membership_inactive" });

    const needPw = await hasPassword(email);
    if (needPw) {
      if (!password) return res.status(401).json({ ok: false, error: "password_required" });
      const v = await verifyPassword(email, password);
      if (!v.ok) return res.status(401).json({ ok: false, error: "invalid_password" });
    }

    return res.json({ ok: true, active: true, membership: m });
  } catch (e) {
    console.log("[AUTH_LOGIN] error", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
};
