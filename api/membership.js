const cors = require("./_cors");
const { getLatestMembershipByEmail, isActiveMembership } = require("./membership/_membership");

// GET /api/membership?email=...
module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "Method not allowed" });

  const email = String(req.query?.email || "").trim().toLowerCase();
  if (!email) return res.status(400).json({ ok: false, error: "email_required" });

  try {
    const m = await getLatestMembershipByEmail(email);
    return res.status(200).json({
      ok: true,
      email,
      membership: m || null,
      active: isActiveMembership(m),
      tier: m?.tier || null,
      planId: m?.plan_id || null,
      status: m?.status || null,
      startAt: m?.start_at || null,
      endAt: m?.end_at || null,
    });
  } catch (e) {
    console.log("[MEMBERSHIP] error:", e?.message || e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
};
