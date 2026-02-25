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
  // Normaliza a string y elimina comillas envolventes si existieran.
  let s = String(raw ?? "");
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

  // Candidate "limpio"
  let candidate = s.trim();
  if (
    (candidate.startsWith('"') && candidate.endsWith('"')) ||
    (candidate.startsWith("'") && candidate.endsWith("'"))
  ) {
    candidate = candidate.slice(1, -1);
  }

  // Validación mínima (NO usamos new URL(), porque puede fallar con passwords no-encoded
  // aunque el driver 'pg' sí pueda conectar).
  if (!/^postgres(ql)?:\/\//i.test(candidate)) {
    console.log("[db] DATABASE_URL check:", meta);
    throw new Error(
      "DATABASE_URL inválida: debe comenzar con postgres:// o postgresql://"
    );
  }

  // Protocol para diagnóstico
  meta.protocol = candidate.split("://")[0] + "://";

  // Safe preview sin exponer password (parse manual tolerante)
  try {
    const schemeSep = candidate.indexOf("://");
    const scheme = candidate.slice(0, schemeSep);
    const rest = candidate.slice(schemeSep + 3); // after ://
    const at = rest.lastIndexOf("@");
    if (at !== -1) {
      const auth = rest.slice(0, at);
      const hostPath = rest.slice(at + 1);
      const user = auth.split(":")[0] || "";
      meta.safePreview = `${scheme}://${user ? "***" : ""}${user ? "@" : ""}${hostPath}`;
    } else {
      meta.safePreview = `${scheme}://${rest}`;
    }
  } catch {
    meta.safePreview = null;
  }

  // Log mínimo (sin credenciales). Visible en Vercel Functions logs.
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
