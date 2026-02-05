// backend/api/_cors.js
module.exports = function cors(req, res) {
  // En producción puedes restringir a tu dominio:
  // const origin = req.headers.origin;
  // const allowed = ["https://www.factorvictoria.com", "https://factorvictoria.com"];
  // if (allowed.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return true;
  }
  return false;
};
