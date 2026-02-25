const cors = require("./_cors");
const db = require("./_db");
const qs = require("querystring");

// GET /api/membership?email=...
module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    // 1) Vercel Node (normal): req.query.email
    let email = (req.query && req.query.email) ? String(req.query.email) : null;

    // 2) Fallback: parsear querystring desde req.url (sin nextUrl/searchParams)
    if (!email) {
      const rawUrl = req.url || "";
      const idx = rawUrl.indexOf("?");
      if (idx >= 0) {
        const parsed = qs.parse(rawUrl.slice(idx + 1));
        if (parsed.email) email = String(parsed.email);
      }
    }

    if (!email) return res.status(400).json({ error: "email requerido" });

    const r = await db.query(
      "select email, plan_id, tier, status, start_at, end_at from memberships where email = $1 limit 1",
      [email]
    );

    const m = r.rows?.[0] || null;
    const active =
      !!(m && m.status === "active" && (!m.end_at || new Date(m.end_at) > new Date()));

    return res.status(200).json({ ok: true, active, membership: m });
  } catch (err) {
    return res.status(500).json({ error: "membership_failed", detail: String(err?.message || err) });
  }
};