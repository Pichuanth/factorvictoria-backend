const cors = require("./_cors");
const db = require("./_db");
const qs = require("querystring");

// GET  /api/membership?email=...
// POST /api/membership  body: { email, action: "cancel" }  -> cancel_at_period_end=true
module.exports = async (req, res) => {
  if (cors(req, res)) return;

  try {
    // DEBUG marker (?marker=1)
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
        marker: "membership-v3-2026-02-26",
        url: req.url || null,
        method: req.method,
        query: req.query ?? null,
      });
    }

    function isActive(m) {
      return !!(m && m.status === "active" && (!m.end_at || new Date(m.end_at) > new Date()));
    }

    // --- POST: cancelar al final del periodo ---
    if (req.method === "POST") {
      const body = req.body || {};
      const email = String(body.email || "").trim().toLowerCase();
      const action = String(body.action || "").trim().toLowerCase();

      if (!email) return res.status(400).json({ error: "email requerido" });
      if (action !== "cancel") return res.status(400).json({ error: "acción inválida" });

      const upd = await db.query(
        `update memberships
         set cancel_at_period_end = true
         where lower(email) = $1
         returning email, plan_id, tier, status, start_at, end_at, cancel_at_period_end`,
        [email]
      );

      const m = upd.rows?.[0] || null;
      return res.status(200).json({ ok: true, active: isActive(m), membership: m });
    }

    // --- GET ---
    if (req.method !== "GET") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    let email = (req.query && req.query.email) ? String(req.query.email) : null;

    if (!email) {
      const rawUrl = req.url || "";
      const idx = rawUrl.indexOf("?");
      const queryStr = idx >= 0 ? rawUrl.slice(idx + 1) : "";
      const parsed = qs.parse(queryStr);
      if (parsed && parsed.email) email = String(parsed.email);
    }

    if (!email) return res.status(400).json({ error: "email requerido" });

    email = String(email).trim().toLowerCase();

    const r = await db.query(
      "select email, plan_id, tier, status, start_at, end_at, cancel_at_period_end from memberships where lower(email) = $1 limit 1",
      [email]
    );

    const m = r.rows && r.rows.length ? r.rows[0] : null;
    return res.status(200).json({ ok: true, active: isActive(m), membership: m });
  } catch (err) {
    return res.status(500).json({
      error: "membership_failed",
      detail: String(err?.message || err),
    });
  }
};
