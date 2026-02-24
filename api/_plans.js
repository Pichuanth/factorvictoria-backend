// backend/api/_plans.js
// Define tus planes aquí (monto en CLP, duración en días y "tier" para PDFs).
module.exports = {
  monthly: { amount: 19990, days: 30, tier: "pro" },
  quarterly: { amount: 44990, days: 90, tier: "pro" },
  annual: { amount: 99990, days: 365, tier: "pro" },
  lifetime: { amount: 249990, days: 3650, tier: "lifetime" }, // opcional
};
