import express from "express";
import cors from "cors";

import payRouter from "./routes/pay.js";
import webhooksRouter from "./routes/webhooks.js";
import adminRouter from "./routes/admin.js";

const app = express();
app.use(cors());
app.use(express.json()); // <— necesario para leer body JSON

app.get("/health", (_req, res) => res.send("ok"));

app.use("/api/pay", payRouter);
app.use("/api/pay", webhooksRouter);
app.use("/admin", adminRouter);

// 404 por defecto
app.use((req, res) => res.status(404).json({ error: "Not found" }));

export default app;
