const cors = require("./_cors");
const db = require("./_db");
const qs = require("querystring");

// GET /api/membership?email=...
module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== "GET")
    return res.status(405).json({ error: "Method not allowed" });

  try {

  // DEBUG marker (no toca DB). Actívalo con ?marker=1
  const rawUrlForMarker = req.url || "";
  const markerIdx = rawUrlForMarker.indexOf("?");
  const markerQs = markerIdx >= 0 ? rawUrlForMarker.slice(markerIdx + 1) : "";
  const markerParsed = qs.parse(markerQs);
  const markerOn =
    (req.query && String(req.query.marker || "") === "1") ||
    (markerParsed && String(markerParsed.marker || "") === "1");

  if (markerOn) {
    return res.status(200).json({
      ok: true,
      marker: "membership-v1-2026-02-25",
      hasNextUrl: Boolean(req && req.nextUrl),
      url: req.url || null,
      method: req.method,
      query: req.query ?? null,
    });
  }

    // 1) Vercel/Express style
    let email = (req.query && req.query.email) ? String(req.query.email) : null;

    // 2) Fallback: parse manual desde req.url (SIN URL/searchParams)
    if (!email) {
      const rawUrl = req.url || "";
      const idx = rawUrl.indexOf("?");
      const queryStr = idx >= 0 ? rawUrl.slice(idx + 1) : "";
      const parsed = qs.parse(queryStr);
      if (parsed && parsed.email) email = String(parsed.email);
    }

    if (!email) return res.status(400).json({ error: "email requerido" });

    const r = await db.query(
      "select email, plan_id, tier, status, start_at, end_at from memberships where email = $1 limit 1",
      [email]
    );

    const m = r.rows && r.rows.length ? r.rows[0] : null;
    const active =
      !!(m && m.status === "active" && (!m.end_at || new Date(m.end_at) > new Date()));

    return res.status(200).json({ ok: true, active, membership: m });
  } catch (err) {
    return res.status(500).json({
      error: "membership_failed",
      detail: String(err?.message || err),
    });
  }
};