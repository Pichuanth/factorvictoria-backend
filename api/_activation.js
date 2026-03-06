// backend/api/_activation.js
// Manejo de tokens de activación y credenciales (password) en Postgres.
const crypto = require("crypto");
const db = require("./_db");

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

async function ensureAuthTables() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS activation_tokens (
      token TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      used_at TIMESTAMPTZ
    );
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_activation_tokens_email
    ON activation_tokens (email);
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS users_auth (
      email TEXT PRIMARY KEY,
      pass_hash TEXT NOT NULL,
      pass_salt TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function createActivationToken(email) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) throw new Error("Email requerido para createActivationToken");

  const token = crypto.randomBytes(24).toString("hex");
  await ensureAuthTables();

  // Invalidar tokens anteriores sin usar para este email, para dejar un flujo simple.
  await db.query(
    `UPDATE activation_tokens
        SET used_at = NOW()
      WHERE email = $1
        AND used_at IS NULL`,
    [normalizedEmail]
  );

  await db.query(
    `INSERT INTO activation_tokens (token, email) VALUES ($1, $2)`,
    [token, normalizedEmail]
  );
  return token;
}

async function consumeActivationToken(token) {
  await ensureAuthTables();
  const r = await db.query(
    `SELECT token, email, used_at, created_at
       FROM activation_tokens
      WHERE token=$1`,
    [token]
  );
  const row = r.rows?.[0];
  if (!row) return { ok: false, error: "Token inválido" };
  if (row.used_at) return { ok: false, error: "Token ya fue usado" };

  // 24h de vigencia
  const ageMs = Date.now() - new Date(row.created_at).getTime();
  if (ageMs > 24 * 60 * 60 * 1000) {
    return { ok: false, error: "Token expirado" };
  }

  await db.query(`UPDATE activation_tokens SET used_at=NOW() WHERE token=$1`, [token]);
  return { ok: true, email: row.email };
}

async function setPassword(email, password) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) throw new Error("Email requerido para setPassword");
  await ensureAuthTables();
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(password, salt, 120000, 32, "sha256").toString("hex");
  await db.query(
    `INSERT INTO users_auth (email, pass_hash, pass_salt)
     VALUES ($1,$2,$3)
     ON CONFLICT (email) DO UPDATE SET pass_hash=EXCLUDED.pass_hash, pass_salt=EXCLUDED.pass_salt`,
    [normalizedEmail, hash, salt]
  );
}

async function verifyPassword(email, password) {
  const normalizedEmail = normalizeEmail(email);
  await ensureAuthTables();
  const r = await db.query(`SELECT pass_hash, pass_salt FROM users_auth WHERE email=$1`, [normalizedEmail]);
  const row = r.rows?.[0];
  if (!row) return { ok: false, missing: true };
  const hash = crypto.pbkdf2Sync(password, row.pass_salt, 120000, 32, "sha256").toString("hex");
  return { ok: hash === row.pass_hash, missing: false };
}

async function hasPassword(email) {
  const normalizedEmail = normalizeEmail(email);
  await ensureAuthTables();
  const r = await db.query(`SELECT 1 FROM users_auth WHERE email=$1`, [normalizedEmail]);
  return !!r.rows?.length;
}

module.exports = {
  ensureAuthTables,
  createActivationToken,
  consumeActivationToken,
  setPassword,
  verifyPassword,
  hasPassword,
  normalizeEmail,
};
