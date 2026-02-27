// backend/api/auth/set-password.js
const cors = require("../_cors");
const { consumeActivationToken, setPassword } = require("../_activation");

// POST /api/auth/set-password { token, password }
module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  let body = {};
  try { body = req.body || JSON.parse(req.body || "{}"); } catch {}
  const token = String(body.token || "").trim();
  const password = String(body.password || "");

  if (!token) return res.status(400).json({ ok: false, error: "token_required" });
  if (!password || password.length < 6) return res.status(400).json({ ok: false, error: "password_too_short" });

  try {
    const t = await consumeActivationToken(token);
    if (!t.ok) return res.status(400).json({ ok: false, error: t.error || "invalid_token" });

    await setPassword(t.email, password);
    return res.json({ ok: true, email: t.email });
  } catch (e) {
    console.log("[SET_PASSWORD] error", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
};
