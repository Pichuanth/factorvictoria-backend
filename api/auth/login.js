const cors = require("../_cors");
const { hasPassword, verifyPassword } = require("../_activation");

// POST /api/auth/login { email, password? }
module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== "POST")
    return res.status(405).json({ ok: false, error: "Method not allowed" });

  let body = {};
  try {
    body = req.body || JSON.parse(req.body || "{}");
  } catch {
    body = {};
  }

  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");

  if (!email) return res.status(400).json({ ok: false, error: "email_required" });

  // membership source of truth
  try {
    const {
      getMembershipByEmail,
      getLatestMembershipByEmail,
      isActiveMembership,
    } = require("../membership/_membership");

    // backwards compatible: helper may export either name
    const getter = getMembershipByEmail || getLatestMembershipByEmail;
    if (typeof getter !== "function") {
      return res.status(500).json({ ok: false, error: "membership_helper_missing" });
    }

    const m = await getter(email);

    if (!isActiveMembership(m)) {
      return res.status(403).json({
        ok: false,
        error: "membership_inactive",
        membership: m || null,
      });
    }

    const needPw = await hasPassword(email);
    if (needPw) {
      if (!password) return res.status(401).json({ ok: false, error: "password_required" });

      const v = await verifyPassword(email, password);
      if (!v.ok) return res.status(401).json({ ok: false, error: "invalid_password" });
    }

    return res.json({
      ok: true,
      active: true,
      needPassword: needPw,
      tier: m?.tier || m?.plan_id || null,
      membership: m || null,
    });
  } catch (e) {
    console.error("[AUTH_LOGIN] error", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
};
