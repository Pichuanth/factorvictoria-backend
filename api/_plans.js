// Central plan catalog used by backend payment + membership.
// planId values must match what the frontend sends (App.jsx /checkout?plan=...).

module.exports = {
  mensual: {
    label: "Mensual",
    amount: 19990,
    currency: "CLP",
    days: 30,
    tier: "basic",
  },
  trimestral: {
    label: "Trimestral (+1 mes regalo)",
    amount: 44990,
    currency: "CLP",
    // 3 meses + 1 de regalo => 4 meses aprox
    days: 120,
    tier: "pro",
  },
  anual: {
    label: "Anual",
    amount: 99990,
    currency: "CLP",
    days: 365,
    tier: "pro",
  },
  vitalicio: {
    label: "Vitalicio",
    amount: 249990,
    currency: "CLP",
    // Lifetime: store a long end date to simplify gating
    days: 36500,
    tier: "pro",
  },
};
