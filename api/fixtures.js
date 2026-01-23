// backend/api/fixtures.js (Vercel Serverless Function)

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

module.exports = async (req, res) => {
  // ---- CORS (allowlist) ----
  const allow = new Set([
    "https://factorvictoria.com",
    "https://www.factorvictoria.com",
    "http://localhost:5173",
  ]);

  const origin = req.headers.origin;
  if (allow.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else {
    res.setHeader("Access-Control-Allow-Origin", "https://factorvictoria.com");
  }

  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, x-admin-token"
  );

  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const from = req.query.from; // YYYY-MM-DD
    const to = req.query.to;     // YYYY-MM-DD
    const country = req.query.country; // opcional
    const q = req.query.q; // opcional

    if (!from || !to) {
      return res.status(400).json({ error: "from and to are required (YYYY-MM-DD)" });
    }

    const key = process.env.APISPORTS_KEY;
    const host = process.env.APISPORTS_HOST || "v3.football.api-sports.io";

    // ✅ Si no hay key en Vercel, NO crashear (esto hoy te evita el 500)
    if (!key) {
      return res.status(200).json({
        items: [],
        note: "APISPORTS_KEY missing on server (Vercel env var not set).",
      });
    }

    // API-SPORTS fixtures endpoint usa date=YYYY-MM-DD (un día por request).
    // Para rango, iteramos día a día.
    const start = new Date(`${from}T00:00:00Z`);
    const end = new Date(`${to}T00:00:00Z`);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      return res.status(400).json({ error: "Invalid date format. Use YYYY-MM-DD" });
    }
    if (end < start) {
      return res.status(400).json({ error: "to must be >= from" });
    }

    const dayMs = 24 * 60 * 60 * 1000;
    const days = Math.floor((end.getTime() - start.getTime()) / dayMs) + 1;

    // límite prudente para serverless (evitar timeouts)
    if (days > 14) {
      return res.status(400).json({
        error: "Range too large. Use max 14 days per request.",
      });
    }

    const all = [];

    for (let i = 0; i < days; i++) {
      const d = new Date(start.getTime() + i * dayMs);
      const yyyy = d.getUTCFullYear();
      const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
      const dd = String(d.getUTCDate()).padStart(2, "0");
      const dateStr = `${yyyy}-${mm}-${dd}`;

      const url = new URL(`https://${host}/fixtures`);
      url.searchParams.set("date", dateStr);

      // si viene country, lo mandamos (API-SPORTS espera nombre en inglés usualmente)
      if (country) url.searchParams.set("country", String(country));

      const r = await fetch(url.toString(), {
        headers: {
          "x-apisports-key": key,
          "x-rapidapi-host": host,
        },
      });

      const data = await r.json().catch(() => null);

      if (!r.ok) {
        // no rompemos todo: devolvemos lo que haya + nota
        return res.status(200).json({
          items: [],
          note: `API-SPORTS error ${r.status} on date=${dateStr}`,
          raw: data,
        });
      }

      const response = Array.isArray(data?.response) ? data.response : [];
      for (const fx of response) all.push(fx);
    }

    // filtro local por q (pais/liga/equipos)
    const qn = norm(q);
    const filtered = qn
      ? all.filter((fx) => {
          const league = norm(fx?.league?.name);
          const ctry = norm(fx?.league?.country);
          const home = norm(fx?.teams?.home?.name);
          const away = norm(fx?.teams?.away?.name);
          return (
            league.includes(qn) ||
            ctry.includes(qn) ||
            home.includes(qn) ||
            away.includes(qn)
          );
        })
      : all;

    return res.status(200).json({
      items: filtered,
      total: filtered.length,
    });
  } catch (err) {
    return res.status(500).json({
      error: "fixtures function crashed",
      detail: String(err?.message || err),
    });
  }
};
