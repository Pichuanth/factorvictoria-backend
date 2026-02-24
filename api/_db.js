// backend/api/_db.js
// DB helper (Postgres) para funciones serverless.
// Requiere env: DATABASE_URL
const { Pool } = require("pg");

let _pool;
function getPool() {
  if (!_pool) {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL missing");
    _pool = new Pool({
      connectionString: process.env.DATABASE_URL,
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
