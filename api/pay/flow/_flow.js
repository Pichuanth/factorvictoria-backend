// backend/api/pay/flow/_flow.js
// Helpers para Flow API (firma + POST form-encoded)
// Docs: https://developers.flow.cl/
const { createHmac } = require("node:crypto");

function normalizeTestMode(v) {
  const s = String(v ?? "").trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes" || s === "on";
}

function flowSign(params, secretKey) {
  const keys = Object.keys(params).sort();
  let toSign = "";
  for (const k of keys) toSign += k + String(params[k]);
  return createHmac("sha256", secretKey).update(toSign).digest("hex");
}

function assertEnv() {
  // Si no defines FLOW_API_URL, elegimos sandbox/prod en base a FLOW_TEST_MODE.
  // - Prod:   https://www.flow.cl/api
  // - Test:   https://sandbox.flow.cl/api
  const testMode = normalizeTestMode(process.env.FLOW_TEST_MODE);
  const FLOW_API_URL =
    (process.env.FLOW_API_URL && String(process.env.FLOW_API_URL).trim()) ||
    (testMode ? "https://sandbox.flow.cl/api" : "https://www.flow.cl/api");

  const FLOW_API_KEY = process.env.FLOW_API_KEY;
  const FLOW_SECRET_KEY = process.env.FLOW_SECRET_KEY;

  if (!FLOW_API_KEY || !FLOW_SECRET_KEY) throw new Error("FLOW_API_KEY/FLOW_SECRET_KEY missing");

  return { FLOW_API_URL, FLOW_API_KEY, FLOW_SECRET_KEY, testMode };
}

function pickErrorMessage(data, fallbackText) {
  if (!data) return fallbackText;
  // Flow suele responder { code, message } o { error, message }
  return (
    data.message ||
    data.error ||
    data.detail ||
    (typeof data === "string" ? data : null) ||
    fallbackText
  );
}

async function flowPost(path, params, opts = {}) {
  const { FLOW_API_URL, FLOW_API_KEY, FLOW_SECRET_KEY } = assertEnv();

  const bodyParams = { ...params, apiKey: FLOW_API_KEY };
  bodyParams.s = flowSign(bodyParams, FLOW_SECRET_KEY);

  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(bodyParams)) form.append(k, String(v));

  // Timeout defensivo (Flow a veces cuelga, y Vercel espera)
  const timeoutMs = Number(opts.timeoutMs || 12000);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new Error("Flow request timeout")), timeoutMs);

  let r, txt, data;
  try {
    r = await fetch(`${FLOW_API_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      signal: ctrl.signal,
    });
    txt = await r.text();
    try {
      data = JSON.parse(txt);
    } catch {
      data = { raw: txt };
    }
  } finally {
    clearTimeout(t);
  }

  if (!r.ok) {
    const msg = pickErrorMessage(data, txt);
    const e = new Error(`Flow ${path} failed: ${r.status} ${msg}`);
    e.status = r.status;
    e.flow = data;
    throw e;
  }

  return data;
}

module.exports = { flowPost, flowSign, assertEnv, normalizeTestMode };
