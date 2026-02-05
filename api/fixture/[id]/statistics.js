// backend/api/fixture/[id]/statistics.js
const cors = require("../../_cors");

module.exports = async (req, res) => {
  if (cors(req, res)) return;

  try {
    const id = req?.query?.id || req?.params?.id;
    if (!process.env.APISPORTS_KEY) {
      return res.status(400).json({ error: "missing_APISPORTS_KEY" });
    }
    if (!id) {
      return res.status(400).json({ error: "missing_fixture_id" });
    }

    const host = process.env.APISPORTS_HOST || "v3.football.api-sports.io";
    const url = `https://${host}/fixtures/statistics?fixture=${encodeURIComponent(id)}`;

    const r = await fetch(url, {
      headers: { "x-apisports-key": process.env.APISPORTS_KEY },
    });

    const data = await r.json().catch(() => ({}));
    return res.status(r.status).json(data);
  } catch (e) {
    return res.status(500).json({ error: "server_error", message: String(e?.message || e) });
  }
};
