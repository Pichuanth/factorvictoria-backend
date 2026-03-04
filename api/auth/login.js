const cors = require("../_cors");
const db = require("../_db");
const { hasPassword, verifyPassword } = require("../_activation");

// POST /api/auth/login  body: { email, password? }
module.exports = async (req, res) => {
  if (cors(req, res)) return;

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  // Body puede venir como string (Vercel) o como objeto.
  let body = {};
  try {
    if (typeof req.body === "string") body = JSON.parse(req.body || "{}");
    else if (req.body && typeof req.body === "object") body = req.body;
  } catch (_) {
    body = {};
  }

  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");

  if (!email) return res.status(400).json({ ok: false, error: "email_required" });

  try {
    // Última membresía por email (case-insensitive)
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

    const status = String(m?.status || "").toLowerCase();
    const active =
      !!m &&
      (status === "active" || status === "paid") &&
      (!endAt || endAt > now);

    if (!active) {
      return res.status(403).json({ ok: false, error: "membership_inactive" });
    }

    // Si el usuario tiene contraseña seteada, la pedimos y validamos
    if (await hasPassword(email)) {
      if (!password) return res.status(401).json({ ok: false, error: "password_required" });
      const okPass = await verifyPassword(email, password);
      if (!okPass) return res.status(401).json({ ok: false, error: "invalid_password" });
    }

    return res.status(200).json({
      ok: true,
      email,
      active: true,
      tier: m?.tier ?? null,
      planId: m?.planId ?? null,
      membership: m,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "login_failed",
      detail: String(err?.message || err),
    });
  }
};
