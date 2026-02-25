throw new Error("MEMBERSHIP_VERSION_99");
const cors = require("./_cors");
const db = require("./_db");
const qs = require("querystring");

// GET /api/membership?email=...
module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    // 1) Prefer req.query (Vercel Node / Express style)
    let email =
      (req.query && req.query.email) ||
      // 2) Next.js style (guarded to avoid 'searchParams' crash)
      (req.nextUrl && req.nextUrl.searchParams && req.nextUrl.searchParams.get
        ? req.nextUrl.searchParams.get("email")
        : null) ||
      null;

    // 3) Final fallback: parse req.url manually (works everywhere)
    if (!email) {
      const rawUrl = req.url || "";
      const qIdx = rawUrl.indexOf("?");
      const queryStr = qIdx >= 0 ? rawUrl.slice(qIdx + 1) : "";
      const parsed = qs.parse(queryStr);
      email = parsed.email || null;
    }

    if (!email) return res.status(400).json({ error: "email requerido" });

    const r = await db.query(
      `select email, user_id, plan_id, tier, status, start_at, end_at
         from memberships
        where lower(email) = lower($1)
        limit 1`,
      [String(email)]
    );

    const m = r.rows && r.rows[0] ? r.rows[0] : null;
    const active = !!(
      m &&
      m.status === "active" &&
      (!m.end_at || new Date(m.end_at) > new Date())
    );

    return res.status(200).json({ ok: true, active, membership: m });
  } catch (err) {
    return res.status(500).json({ error: "membership_failed", detail: String(err && err.message ? err.message : err) });
  }
};
