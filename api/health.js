export default function handler(req, res) {
  res.status(200).json({
    ok: true,
    tz: process.env.APP_TZ || process.env.TZ || null,
    hasDb: !!process.env.DATABASE_URL,
    hasApiKey: !!process.env.APISPORTS_KEY,
    now: new Date().toISOString(),
  });
}
