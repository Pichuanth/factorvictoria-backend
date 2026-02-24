module.exports = (req, res) => {
  res.status(200).json({ ok: true, service: "factorvictoria-backend", ts: Date.now() });
};