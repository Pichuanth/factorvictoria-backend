// backend/api/membership.js
const cors = require("./_cors");
const db = require("./_db");

// GET /api/membership?email=...
module.exports = async (req, res) => {
  if (cors(req, res)) return;

  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    const email = req.query?.email;
    if (!email) return res.status(400).json({ error: "email requerido" });

    const r = await db.query(
      "select email, plan_id, tier, status, start_at, end_at from memberships where email = $1 limit 1",
      [email]
    );
    const m = r.rows?.[0] || null;
    const active = !!(m && m.status === "active" && (!m.end_at || new Date(m.end_at) > new Date()));

    return res.status(200).json({ ok: true, active, membership: m });
  } catch (err) {
    return res.status(500).json({ error: "membership failed", detail: String(err?.message || err) });
  }
};
