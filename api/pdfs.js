// backend/api/pdfs.js
const cors = require("./_cors");
const db = require("./_db");
const fs = require("node:fs");
const path = require("node:path");

// Mapa docId -> archivo y tier mínimo requerido
const DOCS = {
  "guia-1": { file: "guia-1.pdf", minTier: "pro" },
  "guia-2": { file: "guia-2.pdf", minTier: "pro" },
  "guia-3": { file: "guia-3.pdf", minTier: "pro" },
  "guia-pro": { file: "guia-pro.pdf", minTier: "pro" },
};

function tierRank(tier) {
  // Ajusta si agregas tiers
  if (tier === "lifetime") return 2;
  if (tier === "pro") return 1;
  return 0;
}

// GET /api/pdfs?docId=guia-1&email=...
module.exports = async (req, res) => {
  if (cors(req, res)) return;

  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { docId, email } = req.query || {};
    if (!docId || !DOCS[docId]) return res.status(400).json({ error: "docId inválido" });
    if (!email) return res.status(400).json({ error: "email requerido" });

    const r = await db.query(
      "select tier, status, end_at from memberships where email = $1 limit 1",
      [email]
    );
    const m = r.rows?.[0];
    const active = !!(m && m.status === "active" && (!m.end_at || new Date(m.end_at) > new Date()));
    if (!active) return res.status(403).json({ error: "Membresía inactiva" });

    const need = DOCS[docId].minTier;
    if (tierRank(m.tier) < tierRank(need)) return res.status(403).json({ error: "Plan no permite este PDF" });

    const pdfPath = path.join(process.cwd(), "pdfs", DOCS[docId].file);
    if (!fs.existsSync(pdfPath)) return res.status(404).json({ error: "PDF no encontrado en backend/pdfs" });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${DOCS[docId].file}"`);
    fs.createReadStream(pdfPath).pipe(res);
  } catch (err) {
    return res.status(500).json({ error: "pdfs failed", detail: String(err?.message || err) });
  }
};
