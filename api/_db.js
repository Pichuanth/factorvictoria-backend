// backend/api/_db.js
// DB helper (Postgres) para funciones serverless.
// Requiere env: DATABASE_URL
const { Pool } = require("pg");

let _pool;

function _diagnoseDatabaseUrl(raw) {
  // No exponemos credenciales: solo metadatos y un "safe preview".
  const trimmed = (raw || "").trim();
  const meta = {
    present: !!raw,
    length: raw ? raw.length : 0,
    hasLeadingOrTrailingWhitespace: raw ? raw !== trimmed : false,
    startsWithQuote: trimmed.startsWith('"') || trimmed.startsWith("'"),
    endsWithQuote: trimmed.endsWith('"') || trimmed.endsWith("'"),
    hasNewline: raw ? /\r|\n/.test(raw) : false,
    protocol: null,
    safePreview: null,
  };

  // Caso común: variable pegada con comillas.
  const wrappedInQuotes =
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"));

  const candidate = wrappedInQuotes ? trimmed.slice(1, -1) : trimmed;

  let url;
  try {
    url = new URL(candidate);
  } catch (e) {
    // Evita el crash críptico en pg-connection-string (result.searchParams undefined)
    throw new Error(
      "DATABASE_URL inválida (no parseable por URL). " +
        "Revisa formato y caracteres (comillas/espacios/saltos de línea). " +
        "Diagnóstico: " +
        JSON.stringify(meta)
    );
  }

  meta.protocol = url.protocol;

  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error(
      "DATABASE_URL inválida: protocolo no soportado (debe ser postgres:// o postgresql://). " +
        "Diagnóstico: " +
        JSON.stringify(meta)
    );
  }

  // Safe preview SIN password.
  // Ej: postgres://***@host:5432/dbname
  const safeUser = url.username ? "***" : "";
  meta.safePreview = `${url.protocol}//${safeUser}${safeUser ? "@" : ""}${url.host}${url.pathname}`;

  // Log mínimo (sin credenciales). Visible en Vercel Functions logs.
  console.log("[db] DATABASE_URL check:", meta);

  return candidate;
}

function getPool() {
  if (!_pool) {
    const raw = process.env.DATABASE_URL;
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
