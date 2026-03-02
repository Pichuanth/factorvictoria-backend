// backend/api/_cors.js
const ALLOWED = new Set([
  "https://www.factorvictoria.com",
  "https://factorvictoria.com",
  "http://localhost:5173",
  "http://localhost:3000",
]);

module.exports = function cors(req, res) {
  const origin = req.headers.origin;

  // Permitir previews de Vercel del frontend si los usas
  const isVercelPreview =
    origin && /^https:\/\/.*\.vercel\.app$/.test(origin);

  if (origin && (ALLOWED.has(origin) || isVercelPreview)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }

  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Admin-Token"
  );
  res.setHeader("Access-Control-Max-Age", "86400");

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return true; // cortamos aquí
  }
  return false;
};