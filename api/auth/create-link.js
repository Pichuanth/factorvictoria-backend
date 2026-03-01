const cors = require("../_cors");
const db = require("../_db");
const crypto = require("crypto");
const { Resend } = require("resend");

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== "POST") return res.status(200).json({ ok: true });

  try {
    const { email } = req.body || {};
    if (!email) return res.status(200).json({ ok: true });

    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24); // 24h

    await db.query(
      `insert into password_set_tokens (email, token, expires_at)
       values ($1,$2,$3)`,
      [email, token, expiresAt.toISOString()]
    );

    const FRONTEND_URL = (process.env.FRONTEND_URL || "").replace(/\/+$/, "");
    const link = `${FRONTEND_URL}/set-password?token=${encodeURIComponent(token)}`;

    const resend = new Resend(process.env.RESEND_API_KEY);
    const from = process.env.EMAIL_FROM || "onboarding@resend.dev";

    await resend.emails.send({
      from,
      to: email,
      subject: "Crea tu contraseña - Factor Victoria",
      html: `
        <div style="font-family:Arial,sans-serif">
          <h2>Pago confirmado ✅</h2>
          <p>Para crear tu contraseña y entrar cuando quieras, haz clic aquí:</p>
          <p><a href="${link}">${link}</a></p>
          <p>Este link expira en 24 horas.</p>
        </div>
      `,
    });

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.log("[PASSWORD_LINK] error:", e?.message || e);
    return res.status(200).json({ ok: true }); // nunca rompas
  }
};