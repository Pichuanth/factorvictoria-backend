const express = require("express");
const axios = require("axios");
const crypto = require("crypto");

const router = express.Router();

/**
 * FLOW confirmation webhook:
 * Flow sends POST (application/x-www-form-urlencoded) with body: token=<token>
 * We must respond 200 within 15s, and validate by calling /payment/getStatus with apiKey, token and signature `s`.
 * Docs: "Confirmación de orden" + "Estado de orden"
 */

function flowSign(params, secretKey) {
  const keys = Object.keys(params).sort();
  let toSign = "";
  for (const k of keys) toSign += k + String(params[k]);
  return crypto.createHmac("sha256", secretKey).update(toSign).digest("hex");
}

function getFlowConfig() {
  const apiUrl = process.env.FLOW_API_URL || "https://www.flow.cl/api";
  const apiKey = process.env.FLOW_API_KEY;
  const secretKey = process.env.FLOW_SECRET_KEY;
  if (!apiKey || !secretKey) throw new Error("Missing FLOW_API_KEY / FLOW_SECRET_KEY");
  return { apiUrl, apiKey, secretKey };
}

async function flowGetStatus(token) {
  const { apiUrl, apiKey, secretKey } = getFlowConfig();
  const params = { apiKey, token };
  const s = flowSign(params, secretKey);
  const resp = await axios.get(`${apiUrl}/payment/getStatus`, { params: { ...params, s }, timeout: 15000 });
  return resp.data;
}

router.post("/flow/confirm", express.urlencoded({ extended: false }), async (req, res) => {
  // ALWAYS ack quickly (Flow expects < 15s)
  res.status(200).send("OK");

  try {
    const token = req.body?.token;
    if (!token) return console.warn("Flow confirm without token");

    const statusData = await flowGetStatus(token);

    // status: 1 pending, 2 paid, 3 rejected, 4 cancelled
    const { status, commerceOrder, amount, email } = statusData || {};
    console.log("FLOW status:", { status, commerceOrder, amount, email });

    if (Number(status) !== 2) {
      // TODO: update payment as pending/rejected/etc in DB
      return;
    }

    // TODO: Activate membership in DB by commerceOrder (we recommend storing mapping at /flow/create)
    // 1) lookup payment intent by providerToken or commerceOrder
    // 2) set user.plan = planId, user.plan_until, etc.
    // 3) log payment record
    // 4) trigger gift workflow / send docs email

  } catch (err) {
    console.error("FLOW confirm handler error:", err?.response?.data || err);
  }
});

module.exports = router;
