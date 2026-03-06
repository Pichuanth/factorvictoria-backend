const cors = require("../_cors");
const { Resend } = require("resend");
const { createActivationToken, normalizeEmail } = require("../_activation");

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== "POST") return res.status(200).json({ ok: true });

  try {
    const email = normalizeEmail(req.body?.email);
    if (!email) return res.status(200).json({ ok: true });

    const token = await createActivationToken(email);

    const FRONTEND_URL = (process.env.FRONTEND_URL || "https://factorvictoria.com").replace(/\/+$/, "");
    const link = `${FRONTEND_URL}/set-password?token=${encodeURIComponent(token)}`;

    const resendKey = process.env.RESEND_API_KEY;
    if (!resendKey) {
      console.log("[PASSWORD_LINK] missing RESEND_API_KEY", { email, link });
      return res.status(200).json({ ok: true, queued: false, reason: "missing_resend_key" });
    }

    const resend = new Resend(resendKey);
    const from = process.env.EMAIL_FROM || "Factor Victoria <onboarding@resend.dev>";

    console.log("[PASSWORD_LINK] sending", { email, link });

    const result = await resend.emails.send({
      from,
      to: email,
      subject: "Activa tu acceso - Factor Victoria",
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#111">
          <h2 style="margin-bottom:16px">Pago confirmado ✅</h2>
          <p style="font-size:15px;line-height:1.6">
            Tu membresía ya está activa. Para crear tu contraseña y dejar tu acceso listo,
            haz clic en el siguiente botón:
          </p>
          <p style="margin:24px 0">
            <a href="${link}" style="background:#0ea5e9;color:#fff;text-decoration:none;padding:12px 18px;border-radius:8px;display:inline-block;font-weight:700">
              Crear contraseña
            </a>
          </p>
          <p style="font-size:14px;line-height:1.6">
            Si el botón no abre, copia y pega este link en tu navegador:
          </p>
          <p style="font-size:13px;word-break:break-all;color:#444">${link}</p>
          <p style="font-size:14px;color:#666;margin-top:20px">
            Este link expira en 24 horas. Si no fuiste tú, ignora este correo.
          </p>
        </div>
      `,
    });

    console.log("[PASSWORD_LINK] sent", {
      email,
      id: result?.data?.id || result?.id || null,
      error: result?.error || null,
    });

    return res.status(200).json({ ok: true, sent: true });
  } catch (e) {
    console.log("[PASSWORD_LINK] error:", e?.message || e);
    return res.status(200).json({ ok: true }); // nunca rompas el flujo de pago
  }
};
