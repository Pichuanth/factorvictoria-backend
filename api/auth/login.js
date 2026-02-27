// backend/api/auth/login.js
const cors = require("../_cors");
const { hasPassword, verifyPassword } = require("../_activation");

// POST /api/auth/login { email, password }
module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  let body = {};
  try { body = req.body || JSON.parse(req.body || "{}"); } catch {}
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");

  if (!email) return res.status(400).json({ ok: false, error: "email_required" });

  // membership source of truth
  try {
    const { getMembershipByEmail } = require("../membership/_membership");
    const m = await getMembershipByEmail(email);
    if (!m?.active) return res.status(403).json({ ok: false, error: "membership_inactive" });

    const needPw = await hasPassword(email);
    if (needPw) {
      if (!password) return res.status(401).json({ ok: false, error: "password_required" });
      const v = await verifyPassword(email, password);
      if (!v.ok) return res.status(401).json({ ok: false, error: "invalid_password" });
    }

    return res.json({ ok: true, membership, active: true });
  } catch (e) {
    console.log("[AUTH_LOGIN] error", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
};
