// backend/api/pdfs.js
const cors = require("./_cors");
const db = require("./_db");
const fs = require("node:fs");
const path = require("node:path");

const DOCS = {
  // Guías
  "guia-1": { file: "guia-1.pdf", title: "Guía 1", tiers: ["basic", "goleador", "campeon", "leyenda"] },
  "guia-2": { file: "guia-2.pdf", title: "Guía 2", tiers: ["goleador", "campeon", "leyenda"] },
  "guia-3": { file: "guia-3.pdf", title: "Guía 3", tiers: ["campeon", "leyenda"] },

  // Estrategias
  "estrategia-core": { file: "estrategia-core.pdf", title: "Estrategia Core", tiers: ["goleador", "campeon", "leyenda"] },
  "estrategia-pro": { file: "estrategia-pro.pdf", title: "Estrategia Pro", tiers: ["campeon", "leyenda"] },
  "estrategia-elite": { file: "estrategia-elite.pdf", title: "Estrategia Elite", tiers: ["leyenda"] },
};

function normalizeTier(rawTier) {
  const t = String(rawTier || "").trim().toLowerCase();
  if (["basic", "goleador", "campeon", "leyenda"].includes(t)) return t;

  // compat legacy
  if (t === "vip" || t === "lifetime") return "leyenda";
  if (t === "pro") return "campeon";

  return "basic";
}

function isMembershipActive(m) {
  return !!(m && m.status === "active" && (!m.end_at || new Date(m.end_at) > new Date()));
}

function allowedDocIdsByTier(tier) {
  const out = [];
  for (const [docId, meta] of Object.entries(DOCS)) {
    if (meta.tiers.includes(tier)) out.push(docId);
  }
  const order = ["guia-1","guia-2","guia-3","estrategia-core","estrategia-pro","estrategia-elite"];
  out.sort((a,b)=>order.indexOf(a)-order.indexOf(b));
  return out;
}

// GET /api/pdfs?email=...               -> lista documentos permitidos
// GET /api/pdfs?email=...&docId=guia-1  -> descarga PDF (si permitido)
module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { docId, email } = req.query || {};
    if (!email) return res.status(400).json({ error: "email requerido" });

    const r = await db.query(
      "select tier, status, end_at from memberships where email = $1 limit 1",
      [email]
    );
    const m = r.rows?.[0];
    if (!isMembershipActive(m)) return res.status(403).json({ error: "Membresía inactiva" });

    const tier = normalizeTier(m.tier);

    // LISTA
    if (!docId) {
      const docs = allowedDocIdsByTier(tier).map((id) => ({ id, title: DOCS[id].title }));
      return res.status(200).json({ ok: true, tier, docs });
    }

    // DESCARGA
    if (!DOCS[docId]) return res.status(400).json({ error: "docId inválido" });
    if (!DOCS[docId].tiers.includes(tier)) return res.status(403).json({ error: "Plan no permite este PDF" });

    const pdfPath = path.join(process.cwd(), "pdfs", DOCS[docId].file);
    if (!fs.existsSync(pdfPath)) return res.status(404).json({ error: "PDF no encontrado en backend/pdfs" });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${DOCS[docId].file}"`);
    fs.createReadStream(pdfPath).pipe(res);
  } catch (err) {
    return res.status(500).json({ error: "pdfs failed", detail: String(err?.message || err) });
  }
};