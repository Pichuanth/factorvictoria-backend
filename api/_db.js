// backend/api/_db.js
// DB helper (Postgres) para funciones serverless.
// Soporta DATABASE_URL y variables típicas de Vercel Postgres (POSTGRES_URL*).
const { Pool } = require("pg");

let _pool;

/**
 * Valida y diagnóstica la URL de conexión sin exponer credenciales.
 * - Loguea meta segura en Vercel Functions logs.
 * - Lanza error claro si la URL no es parseable.
 */
function _diagnoseDatabaseUrl(raw) {
  const s = String(raw ?? "");
  const meta = {
    present: Boolean(raw),
    length: s.length,
    hasLeadingOrTrailingWhitespace: s !== s.trim(),
    startsWithQuote: s.startsWith('"') || s.startsWith("'"),
    endsWithQuote: s.endsWith('"') || s.endsWith("'"),
    hasNewline: /\r|\n/.test(s),
    protocol: null,
    safePreview: null,
    rawFingerprint: {
      head: s.slice(0, 12),
      tail: s.slice(-8),
      hasSchemeSep: s.includes("://"),
      hasAt: s.includes("@"),
      hasColon: s.includes(":"),
      hasSlash: s.includes("/"),
      hasQuestion: s.includes("?"),
      hasControlChars: /[\u0000-\u001F\u007F]/.test(s),
    },
  };

  // Normaliza comillas externas comunes (por si alguien pegó con comillas).
  let candidate = s.trim();
  if ((candidate.startsWith('"') && candidate.endsWith('"')) || (candidate.startsWith("'") && candidate.endsWith("'"))) {
    candidate = candidate.slice(1, -1);
  }

  // Valida formato URL (postgres:// o postgresql://)
  let url;
  try {
    url = new URL(candidate);
  } catch (e) {
    console.log("[db] DATABASE_URL check:", meta);
    throw new Error(
      "DATABASE_URL inválida (no parseable por URL). Revisa formato y caracteres (comillas/espacios/saltos de línea). Diagnóstico: " +
        JSON.stringify({
          present: meta.present,
          length: meta.length,
          hasLeadingOrTrailingWhitespace: meta.hasLeadingOrTrailingWhitespace,
          startsWithQuote: meta.startsWithQuote,
          endsWithQuote: meta.endsWithQuote,
          hasNewline: meta.hasNewline,
          protocol: meta.protocol,
          safePreview: meta.safePreview,
          rawFingerprint: meta.rawFingerprint,
        })
    );
  }

  meta.protocol = url.protocol; // p.ej. 'postgres:' o 'postgresql:'

  // Safe preview sin password (mask user).
  const safeUser = url.username ? "***" : "";
  const hasAuth = Boolean(url.username) || Boolean(url.password);
  meta.safePreview = `${url.protocol}//${hasAuth ? safeUser + "@" : ""}${url.host}${url.pathname}`;

  console.log("[db] DATABASE_URL check:", meta);
  return candidate;
}

function getPool() {
  if (!_pool) {
    const raw =
      process.env.DATABASE_URL ||
      process.env.POSTGRES_URL ||
      process.env.POSTGRES_PRISMA_URL ||
      process.env.POSTGRES_URL_NON_POOLING;

    if (!raw) throw new Error("DATABASE_URL missing");

    const connectionString = _diagnoseDatabaseUrl(raw);

    _pool = new Pool({
      connectionString,
      ssl: process.env.PGSSL_DISABLE ? false : { rejectUnauthorized: false },
      max: 1,
    });
  }
  return _pool;
}

module.exports = {
  query: async (text, params) => {
    const pool = getPool();
    return pool.query(text, params);
  },
};
