// backend/api/membership.js
const cors = require("./_cors");
const db = require("./_db");

// GET /api/membership?email=...
module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "Method not allowed" });

  const email = String((req.query && req.query.email) || "").trim().toLowerCase();
  if (!email) return res.status(400).json({ ok: false, error: "email_required" });

  try {
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

    return res.json({
      ok: true,
      email,
      membership: m,
      active,
      tier: m?.tier || null,
      planId: m?.planId || null,
      status: m?.status || null,
      startAt: m?.startAt || null,
      endAt: m?.endAt || null,
    });
  } catch (e) {
    console.log("[MEMBERSHIP] error", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
};
