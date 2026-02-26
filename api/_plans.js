// Central plan catalog used by backend payment + membership.
// planId values must match what the frontend sends (e.g. /checkout?plan=mensual).

module.exports = {
  mensual: {
    label: "Inicio (Mensual)",
    amount: 19990,
    currency: "CLP",
    days: 30,
    tier: "basic", // x10
  },
  trimestral: {
    label: "Goleador (4 meses)",
    amount: 44990,
    currency: "CLP",
    days: 120, // 4 meses
    tier: "goleador", // x20
  },
  anual: {
    label: "Campeón (Anual)",
    amount: 99990,
    currency: "CLP",
    days: 365,
    tier: "campeon", // x50
  },
  vitalicio: {
    label: "Leyenda (Vitalicio)",
    amount: 249990,
    currency: "CLP",
    days: null,      // vitalicio real => end_at NULL
    tier: "leyenda", // x100
  },
};
