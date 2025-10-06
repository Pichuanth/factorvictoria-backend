import crypto from "crypto";
import express from "express";
import fetch from "node-fetch";
const r = express.Router();

const PRICES = { "pro-100":19990, "pro-45":44990, "pro-250":99990, "lifetime":249990 };

// util: firma HMAC-SHA256 (params ordenados alfabéticamente, sin "signature")
function signFlow(params, secret){
  const sorted = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join("&");
  return crypto.createHmac("sha256", secret).update(sorted).digest("hex");
}

r.post("/checkout", async (req,res)=>{
  try{
    const { provider, plan } = req.query;
    const amount = PRICES[plan];
    if(!amount) return res.status(400).json({error:"plan inválido"});
    const userEmail = req.body?.email || "cliente@example.com";

    if(provider === "mp"){
      // ... (tu bloque de MP con installments: 6) ...
    }

    if(provider === "flow"){
      const base = process.env.FLOW_API_BASE || "https://sandbox.flow.cl/api";
      const payload = {
        apiKey: process.env.FLOW_API_KEY,
        commerceOrder: `FV-${plan}-${Date.now()}`,
        subject: `Factor Victoria - ${plan}`,
        currency: "CLP",
        amount,
        email: userEmail,
        urlConfirmation: process.env.FLOW_WEBHOOK_URL,
        urlReturn: process.env.FLOW_RETURN_URL,
      };
      const signature = signFlow(payload, process.env.FLOW_SECRET);
      const body = new URLSearchParams({ ...payload, signature });

      const resp = await fetch(`${base}/payment/create`, {
        method:"POST",
        headers:{ "Content-Type":"application/x-www-form-urlencoded" },
        body
      });
      const data = await resp.json();
      if(!data?.url) return res.status(500).json({error:"flow_create_failed", detail:data});
      return res.json({ payment_url: data.url });
    }

    return res.status(400).json({error:"provider inválido"});
  }catch(e){
    console.error(e);
    res.status(500).json({error:"checkout_error"});
  }
});

export default r;
