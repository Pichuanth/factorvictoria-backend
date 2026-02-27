// backend/api/_mail.js
// Envío de email (Resend). Si no hay API key, solo loguea el link.
async function sendActivationEmail({ to, activationLink }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM || "Factor Victoria <no-reply@factorvictoria.com>";

  const subject = "Activa tu cuenta de Factor Victoria";
  const text = `Tu pago fue confirmado. Para crear tu contraseña y activar tu cuenta, abre: ${activationLink}`;

  if (!apiKey) {
    console.log("[MAIL] RESEND_API_KEY no configurada. Link de activación:", activationLink);
    return { ok: false, skipped: true };
  }

  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to,
      subject,
      text,
    }),
  });

  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.log("[MAIL] Error enviando:", r.status, data);
    return { ok: false, error: "send_failed" };
  }
  return { ok: true, id: data?.id };
}

module.exports = { sendActivationEmail };
