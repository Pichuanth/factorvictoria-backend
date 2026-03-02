const db = require("../_db");

// NOTE: We keep this helper in api/membership/_membership.js because Vercel runs on Linux
// and paths/filenames are case-sensitive. Some earlier versions used a misspelled filename
// like _memmership.js which works on Windows but fails on Vercel.

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

// Returns the latest membership row for an email (or null).
async function getLatestMembershipByEmail(email) {
  email = normalizeEmail(email);
  if (!email) return null;

  // Table name can vary depending on your schema. We support both:
  // - memberships (recommended)
  // - membership (legacy)
  const candidates = ["memberships", "membership"];

  for (const table of candidates) {
    try {
      const { rows } = await db.query(
        `
        SELECT *
        FROM ${table}
        WHERE lower(email) = $1
        ORDER BY COALESCE(updated_at, created_at, now()) DESC, id DESC
        LIMIT 1
        `,
        [email]
      );
      if (rows && rows[0]) return rows[0];
    } catch (e) {
      // try next table name
    }
  }

  return null;
}

async function getMembershipByEmail(email) {
  return getLatestMembershipByEmail(email);
}

function isActiveMembership(m) {
  if (!m) return false;
  // Support different schemas:
  // - active boolean
  // - status string
  // - expires_at timestamp
  if (typeof m.active === "boolean") return m.active;

  const status = String(m.status || "").toLowerCase();
  if (status) return status === "active" || status === "paid" || status === "ok";

  const exp = m.expires_at || m.expire_at || m.valid_until;
  if (exp) {
    const t = new Date(exp).getTime();
    if (!Number.isNaN(t)) return t > Date.now();
  }

  // If we only have a plan_id/tier and no status fields, treat as active
  // (better to allow access than block paying users).
  if (m.plan_id || m.tier) return true;

  return false;
}

module.exports = {
  getMembershipByEmail,
  getLatestMembershipByEmail,
  isActiveMembership,
};
