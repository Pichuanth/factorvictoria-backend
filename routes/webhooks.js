// backend/routes/webhooks.js
import express from "express";
import crypto from "crypto";
import fetch from "node-fetch";
const r = express.Router();

function verifyFlow(req, secret){
  const params = { ...req.body };
  const given = params.signature; delete params.signature;
  const sorted = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join("&");
  const calc = crypto.createHmac("sha256", secret).update(sorted).digest("hex");
  return calc === given;
}

r.post("/flow/webhook", async (req,res)=>{
  try{
    if(!verifyFlow(req, process.env.FLOW_SECRET)) return res.sendStatus(401);

    // Recomendado: consultar estado con token en /payment/getStatus
    const base = process.env.FLOW_API_BASE || "https://sandbox.flow.cl/api";
    const token = req.body?.token; // Flow envía token del pago
    if(token){
      const params = { apiKey: process.env.FLOW_API_KEY, token };
      const signature = crypto.createHmac("sha256", process.env.FLOW_SECRET)
        .update(Object.keys(params).sort().map(k => `${k}=${params[k]}`).join("&")).digest("hex");

      const qs = new URLSearchParams({ ...params, signature }).toString();
      const st = await fetch(`${base}/payment/getStatus?${qs}`).then(r=>r.json());

      // si st.status === "paid"/"completed"/aprobado -> activa membresía
      // await db... (tu UPDATE aquí)
    }

    res.sendStatus(200);
  }catch(e){
    console.error(e);
    res.sendStatus(500);
  }
});

export default r;
