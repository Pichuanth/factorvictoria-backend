// backend/api/pay/flow/_flow.js
// Firma y request helpers para Flow API v1
// Docs: https://developers.flow.cl/en/docs/tutorial-basics/create-order
const { createHmac } = require("node:crypto");

function flowSign(params, secretKey) {
  const keys = Object.keys(params).sort();
  let toSign = "";
  for (const k of keys) toSign += k + String(params[k]);
  return createHmac("sha256", secretKey).update(toSign).digest("hex");
}

function assertEnv() {
  const FLOW_API_URL = process.env.FLOW_API_URL || "https://www.flow.cl/api";
  const FLOW_API_KEY = process.env.FLOW_API_KEY;
  const FLOW_SECRET_KEY = process.env.FLOW_SECRET_KEY;
  if (!FLOW_API_KEY || !FLOW_SECRET_KEY) throw new Error("FLOW_API_KEY/FLOW_SECRET_KEY missing");
  return { FLOW_API_URL, FLOW_API_KEY, FLOW_SECRET_KEY };
}

async function flowPost(path, params) {
  const { FLOW_API_URL, FLOW_API_KEY, FLOW_SECRET_KEY } = assertEnv();
  const bodyParams = { ...params, apiKey: FLOW_API_KEY };
  bodyParams.s = flowSign(bodyParams, FLOW_SECRET_KEY);

  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(bodyParams)) form.append(k, String(v));

  const r = await fetch(`${FLOW_API_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });

  const txt = await r.text();
  let data;
  try { data = JSON.parse(txt); } catch { data = { raw: txt }; }
  if (!r.ok) {
    const msg = data?.message || data?.error || txt;
    throw new Error(`Flow ${path} failed: ${r.status} ${msg}`);
  }
  return data;
}

module.exports = { flowPost, flowSign, assertEnv };
