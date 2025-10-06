// backend/routes/admin.js
import express from "express";
// import { pool } from "../db.js"; // úsalo cuando quieras escribir en tu DB

const r = express.Router();

// sanity check
r.get("/ping", (req, res) => res.json({ ok: true }));

// grant de membresía (mock ok para ver respuesta)
// cuando conectes DB, descomenta el bloque de SQL y quita el mock.
r.post("/memberships/grant", async (req, res) => {
  try {
    const { email, plan = "lifetime", months = 3 } = req.body;
    console.log("GRANT >>", req.headers["x-admin-token"], email, plan, months);

    // --- MOCK (responde ok sin DB) ---
    const expires = new Date(Date.now() + 1000 * 60 * 60 * 24 * 365 * 30);
    return res.json({ ok: true, email, plan, expires });

    /* --- DB REAL (descomenta cuando tengas pool) ---
    const now = new Date();
    let expires = new Date(now);
    if (plan === "lifetime") expires.setFullYear(now.getFullYear() + 30);
    else expires.setMonth(now.getMonth() + months);

    await pool.query(`
      INSERT INTO users_app (email, membership_active, plan, membership_expires_at)
      VALUES ($1,true,$2,$3)
      ON CONFLICT (email)
      DO UPDATE SET membership_active=true, plan=$2, membership_expires_at=$3
    `, [email, plan, expires]);

    return res.json({ ok: true, email, plan, expires });
    */
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "db_error" });
  }
});

export default r;
