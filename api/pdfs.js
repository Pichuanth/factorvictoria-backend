// backend/api/pdfs.js
// ✅ Endpoint único para:
// - Listar documentos permitidos por tier: GET /api/pdfs?email=...
// - Descargar un documento permitido:     GET /api/pdfs?email=...&docId=...
//
// IMPORTANTE: no depende de plan_id, solo de memberships.tier
const cors = require("./_cors");
const db = require("./_db");
const fs = require("node:fs");
const path = require("node:path");

/**
 * Tiers oficiales:
 * - basic    (x10)
 * - goleador (x20)
 * - campeon  (x50)
 * - leyenda  (x100)
 */
function tierRank(tier) {
  const t = String(tier || "").toLowerCase();
  if (t === "leyenda") return 3;
  if (t === "campeon") return 2;
  if (t === "goleador") return 1;
  if (t === "basic") return 0;
  return -1;
}

// Catálogo global (id -> { title, file })
const DOCS = {
  // Guías
  "guia-1": { title: "Guía 1", file: "guia-1.pdf" },
  "guia-2": { title: "Guía 2", file: "guia-2.pdf" },
  "guia-3": { title: "Guía 3", file: "guia-3.pdf" },

  // Estrategias
  "estrategia-core": { title: "Estrategia Core", file: "estrategia-core.pdf" },
  "estrategia-pro": { title: "Estrategia Pro", file: "estrategia-pro.pdf" },
  "estrategia-elite": { title: "Estrategia Elite", file: "estrategia-elite.pdf" },
};

// Permisos por tier
const ALLOW = {
  basic: ["guia-1"],
  goleador: ["guia-1", "guia-2", "estrategia-core"],
  campeon: ["guia-1", "guia-2", "guia-3", "estrategia-core", "estrategia-pro"],
  leyenda: ["guia-1", "guia-2", "guia-3", "estrategia-core", "estrategia-pro", "estrategia-elite"],
};

function getAllowedDocsForTier(tier) {
  const t = String(tier || "").toLowerCase();
  const ids = ALLOW[t] || [];
  return ids
    .map((id) => (DOCS[id] ? { id, title: DOCS[id].title } : null))
    .filter(Boolean);
}

function resolvePdfDir() {
  // Vercel puede ejecutar con distintos cwd dependiendo del proyecto
  const candidates = [
    path.join(process.cwd(), "pdfs"),
    path.join(process.cwd(), "backend", "pdfs"),
    path.join(process.cwd(), "..", "pdfs"),
    path.join(process.cwd(), "..", "backend", "pdfs"),
  ];
  for (const dir of candidates) {
    try {
      if (fs.existsSync(dir)) return dir;
    } catch {
      // ignore
    }
  }
  return null;
}

module.exports = async (req, res) => {
  if (cors(req, res)) return;

  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    const q = req.query || {};
    const emailRaw = q.email;
    const docIdRaw = q.docId;

    if (!emailRaw) return res.status(400).json({ error: "email requerido" });
    const email = String(emailRaw).trim().toLowerCase();

    const r = await db.query(
      "select tier, status, end_at from memberships where lower(email) = $1 limit 1",
      [email]
    );
    const m = r.rows?.[0] || null;

    const active = !!(m && m.status === "active" && (!m.end_at || new Date(m.end_at) > new Date()));
    if (!active) return res.status(403).json({ error: "Membresía inactiva" });

    const tier = String(m.tier || "").toLowerCase();
    if (tierRank(tier) < 0) return res.status(403).json({ error: "Tier inválido" });

    const docs = getAllowedDocsForTier(tier);

    // 1) LISTA (sin docId)
    if (!docIdRaw) {
      return res.status(200).json({ ok: true, tier, docs });
    }

    // 2) DESCARGA
    const docId = String(docIdRaw).trim();
    const allowedIds = new Set((ALLOW[tier] || []).map(String));
    if (!allowedIds.has(docId)) return res.status(403).json({ error: "Plan no permite este PDF" });
    if (!DOCS[docId]) return res.status(400).json({ error: "docId inválido" });

    const pdfDir = resolvePdfDir();
    if (!pdfDir) return res.status(404).json({ error: "Carpeta PDFs no encontrada en deploy" });

    const fileName = DOCS[docId].file;
    const pdfPath = path.join(pdfDir, fileName);

    if (!fs.existsSync(pdfPath)) {
      return res.status(404).json({
        error: `PDF no encontrado: ${fileName}`,
        pdfDir,
        hint: "Asegúrate de commitear los PDFs (si están ignorados usa: git add -f pdfs/*.pdf)",
      });
    }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename=\"${fileName}\"`);
    return fs.createReadStream(pdfPath).pipe(res);
  } catch (err) {
    return res.status(500).json({ error: "pdfs failed", detail: String(err?.message || err) });
  }
};
