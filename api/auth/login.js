const cors = require("../_cors");
const { hasPassword, verifyPassword } = require("../_activation");
const {
  getLatestMembershipByEmail,
  isActiveMembership,
} = require("../membership/_membership");

// POST /api/auth/login { email, password? }
module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== "POST")
    return res.status(405).json({ ok: false, error: "method_not_allowed" });

  let body = {};
  try {
    body = req.body || JSON.parse(req.body || "{}");
  } catch (_) {}

  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");

  if (!email) return res.status(400).json({ ok: false, error: "email_required" });

  try {
    const m = await getLatestMembershipByEmail(email);
    if (!isActiveMembership(m)) {
      return res.status(403).json({ ok: false, error: "membership_inactive" });
    }

    // Optional password: only enforce if user already created one
    const needPw = await hasPassword(email);
    if (needPw) {
      if (!password) return res.status(401).json({ ok: false, error: "password_required" });
      const v = await verifyPassword(email, password);
      if (!v.ok) return res.status(401).json({ ok: false, error: "invalid_password" });
    }

    return res.json({
      ok: true,
      active: true,
      email,
      tier: m.tier,
      planId: m.plan_id,
      membership: m,
      needsPassword: needPw,
    });
  } catch (e) {
    console.error("[AUTH_LOGIN] error", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
};
