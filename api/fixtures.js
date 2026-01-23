// backend/api/fixtures.js (Vercel Serverless Function)

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function isYYYYMMDD(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
}

function addDaysYYYYMMDD(dateStr, days) {
  // dateStr: YYYY-MM-DD (sin zona)
  const [y, m, d] = String(dateStr).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0)); // 12:00 UTC evita DST edge
  dt.setUTCDate(dt.getUTCDate() + Number(days || 0));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

module.exports = async (req, res) => {
  // ---- CORS (allowlist) ----
  const allow = new Set([
    "https://factorvictoria.com",
    "https://www.factorvictoria.com",
    "http://localhost:5173",
  ]);

  const origin = req.headers.origin;
  res.setHeader("Access-Control-Allow-Origin", allow.has(origin) ? origin : "https://factorvictoria.com");
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-admin-token");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const from = req.query.from;        // YYYY-MM-DD
    const to = req.query.to;            // YYYY-MM-DD
    const country = req.query.country;  // opcional
    const q = req.query.q;              // opcional

    if (!isYYYYMMDD(from) || !isYYYYMMDD(to)) {
      return res.status(400).json({ error: "from and to are required (YYYY-MM-DD)" });
    }

    const key = process.env.APISPORTS_KEY;
    const host = process.env.APISPORTS_HOST || "v3.football.api-sports.io";

    if (!key) {
      return res.status(200).json({ items: [], note: "APISPORTS_KEY missing on server (Vercel env var not set)." });
    }

    // Calcula days sin depender de TZ local
    // (máx 14 días)
    let days = 1;
    {
      const [y1, m1, d1] = from.split("-").map(Number);
      const [y2, m2, d2] = to.split("-").map(Number);
      const a = Date.UTC(y1, m1 - 1, d1, 12, 0, 0);
      const b = Date.UTC(y2, m2 - 1, d2, 12, 0, 0);
      if (b < a) return res.status(400).json({ error: "to must be >= from" });

      const dayMs = 24 * 60 * 60 * 1000;
      days = Math.floor((b - a) / dayMs) + 1;
      if (days > 14) {
        return res.status(400).json({ error: "Range too large. Use max 14 days per request." });
      }
    }

    const all = [];

    for (let i = 0; i < days; i++) {
      const dateStr = addDaysYYYYMMDD(from, i);

      const url = new URL(`https://${host}/fixtures`);
      url.searchParams.set("date", dateStr);
      if (country) url.searchParams.set("country", String(country));

      const r = await fetch(url.toString(), {
        headers: {
          "x-apisports-key": key,
          "x-rapidapi-host": host,
        },
      });

      const data = await r.json().catch(() => null);

      if (!r.ok) {
        return res.status(200).json({
          items: [],
          note: `API-SPORTS error ${r.status} on date=${dateStr}`,
          raw: data,
        });
      }

      const response = Array.isArray(data?.response) ? data.response : [];
      for (const fx of response) all.push(fx);
    }

    const qn = norm(q);
    const filtered = qn
      ? all.filter((fx) => {
          const league = norm(fx?.league?.name);
          const ctry = norm(fx?.league?.country);
          const home = norm(fx?.teams?.home?.name);
          const away = norm(fx?.teams?.away?.name);
          return league.includes(qn) || ctry.includes(qn) || home.includes(qn) || away.includes(qn);
        })
      : all;

    return res.status(200).json({ items: filtered, total: filtered.length });
  } catch (err) {
    return res.status(500).json({ error: "fixtures function crashed", detail: String(err?.message || err) });
  }
};
