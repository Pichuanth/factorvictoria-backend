// api/index.js
const serverless = require("serverless-http");
const app = require("../app"); // <-- ESTO ESTÁ BIEN así. Sube 1 nivel desde /api a / (raíz) y carga app.js

module.exports = serverless(app);
