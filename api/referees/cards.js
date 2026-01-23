// backend/api/referees/cards.js (Vercel Serverless Function)
module.exports = async (req, res) => {
  const allow = new Set([
    "https://factorvictoria.com",
    "https://www.factorvictoria.com",
    "http://localhost:5173",
  ]);
  const origin = req.headers.origin;
  if (allow.has(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  else res.setHeader("Access-Control-Allow-Origin", "https://factorvictoria.com");

  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-admin-token");
  if (req.method === "OPTIONS") return res.status(200).end();

  return res.status(501).json({
    ok: false,
    note: "Not implemented yet. Create logic later.",
    items: [],
  });
};
