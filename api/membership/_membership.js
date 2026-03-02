// backend/api/membership/_membership.js
const db = require("../_db");

function _inferTier(planId) {
  const p = String(planId || "").toLowerCase();
  if (p.includes("vital")) return "vitalicio";
  if (p.includes("leyenda")) return "leyenda";
  if (p.includes("campe")) return "campeon";
  if (p.includes("gole")) return "goleador";
  // default: pro unlock (mensual / trimestral / anual)
  return "pro";
}

function isActiveMembership(m) {
  if (!m) return false;
  const status = String(m.status || "").toLowerCase();
  if (status && status !== "active") return false;

  // Optional expiration support if you add end_at later
  if (m.end_at) {
    const end = new Date(m.end_at);
    if (!isNaN(end.getTime()) && end.getTime() < Date.now()) return false;
  }
  return true;
}

async function getLatestMembershipByEmail(email) {
  const e = String(email || "").trim().toLowerCase();
  const q = `
    select *
    from memberships
    where lower(email)=lower($1)
    order by start_at desc nulls last, id desc
    limit 1
  `;
  const r = await db.query(q, [e]);
  return r.rows[0] || null;
}

// Back-compat alias (older code may call this)
async function getMembershipByEmail(email) {
  return getLatestMembershipByEmail(email);
}

// Called from Flow confirm/return after payment is validated.
async function upsertMembershipFromPayment({ email, planId, status = "active", startAt, tier }) {
  const e = String(email || "").trim().toLowerCase();
  const pid = String(planId || "").trim();
  if (!e || !pid) throw new Error("upsertMembershipFromPayment: missing email/planId");

  const t = tier ? String(tier).trim() : _inferTier(pid);
  const s = String(status || "active").trim().toLowerCase();
  const start = startAt ? new Date(startAt) : new Date();
  const startIso = isNaN(start.getTime()) ? new Date().toISOString() : start.toISOString();

  // Insert a new row (keeps history). Login reads the latest.
  const q = `
    insert into memberships (email, plan_id, tier, status, start_at)
    values ($1,$2,$3,$4,$5)
    returning *
  `;
  const r = await db.query(q, [e, pid, t, s, startIso]);
  return r.rows[0] || null;
}

module.exports = {
  getMembershipByEmail,
  getLatestMembershipByEmail,
  isActiveMembership,
  upsertMembershipFromPayment,
};
