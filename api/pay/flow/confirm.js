const cors = require('../../_cors');
const db = require('../../_db');
const qs = require('querystring');
const flow = require('./_flow');

// POST /api/pay/flow/confirm  (server-to-server from Flow)
module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });

  try {
    // Flow sends token in body form or query
    let token =
      (req.query && req.query.token) ||
      (req.body && (req.body.token || req.body.TOKEN)) ||
      null;

    // If Vercel didn't parse body, parse manually
    if (!token) {
      await new Promise((resolve) => {
        let raw = '';
        req.on('data', (c) => (raw += c));
        req.on('end', () => {
          if (raw) {
            const parsed = qs.parse(raw);
            token = parsed.token || parsed.TOKEN || null;
          }
          resolve();
        });
      });
    }

    if (!token) return res.status(400).json({ ok: false, error: 'missing_token' });

    // 1) Ask Flow for status (GET)
    const statusResp = await flow.flowGet('/payment/getStatus', { token });

    // status: 1 pendiente, 2 pagada, 3 rechazada, 4 anulada
    const status = statusResp?.status ?? statusResp?.paymentStatus ?? statusResp?.state ?? null;
    const isPaid = status === 2 || status === '2' || status === 'paid' || status === 'PAID';

    // Store raw status best-effort
    try {
      await db.query(
        `insert into payment_intents (flow_token, status, raw_status, updated_at)
         values ($1, $2, $3, now())
         on conflict (flow_token) do update set status=$2, raw_status=$3, updated_at=now()`,
        [token, isPaid ? 'paid' : 'pending', statusResp || null]
      );
    } catch (e) {}

    if (!isPaid) return res.status(200).json({ ok: true, paid: false, status: status });

    // 2) Resolve payer email + planId from payment_intents (created on /create)
    let email = null;
    let planId = null;

    try {
      const r = await db.query(`select email, plan_id from payment_intents where flow_token=$1 limit 1`, [token]);
      email = r?.rows?.[0]?.email || null;
      planId = r?.rows?.[0]?.plan_id || null;
    } catch (e) {}

    // Fallback: Flow getStatus devuelve payer y optional (json)
    if (!email) email = statusResp?.payer || null;
    if (!planId) {
      const opt = statusResp?.optional;
      if (opt && typeof opt === 'object') planId = opt.planId || opt.plan_id || opt.tier || null;
      if (typeof opt === 'string') {
        try {
          const o = JSON.parse(opt);
          planId = o.planId || o.plan_id || o.tier || null;
          if (!email) email = o.email || null;
        } catch {}
      }
    }

    if (!email || !planId) {
      // Acknowledge Flow but we can't activate
      return res.status(200).json({ ok: true, paid: true, activated: false, reason: 'missing_email_or_plan' });
    }

    // 3) Activate membership (upsert)
    const planDays = {
      mensual: 30,
      trimestral: 120,
      anual: 365,
      vitalicio: null,
      pro: 365,
    };

    const days = planDays[planId] ?? 30;

    // Create table if missing (safe)
    await db.query(`
      create table if not exists memberships (
        email text primary key,
        plan_id text,
        status text,
        start_at timestamptz,
        end_at timestamptz,
        updated_at timestamptz
      )
    `);

    if (days) {
      await db.query(
        `insert into memberships (email, plan_id, status, start_at, end_at, updated_at)
         values (lower($1), $2, 'active', now(), now() + make_interval(days => $3::int), now())
         on conflict (email) do update
           set plan_id=excluded.plan_id,
               status='active',
               start_at=now(),
               end_at=now() + make_interval(days => $3::int),
               updated_at=now()`,
        [email, planId, days]
      );
    } else {
      // vitalicio
      await db.query(
        `insert into memberships (email, plan_id, status, start_at, end_at, updated_at)
         values (lower($1), $2, 'active', now(), NULL, now())
         on conflict (email) do update
           set plan_id=excluded.plan_id,
               status='active',
               start_at=now(),
               end_at=NULL,
               updated_at=now()`,
        [email, planId]
      );
    }

    return res.status(200).json({ ok: true, paid: true, activated: true, email, planId, status });
  } catch (err) {
    console.error('[FLOW_CONFIRM] error', err);
    // Reply 200 so Flow doesn't retry forever
    return res.status(200).json({ ok: false, error: 'confirm_failed', message: String(err?.message || err) });
  }
};
