import { createClient } from '@supabase/supabase-js';

// GET /api/usage — the signed-in user's AI credit meter.
// Auth mirrors api/anthropic.js (Supabase access token); metering math mirrors
// cadence/src/lib/aiBudget.ts (keep in sync).

const SUPABASE_URL =
  process.env.SUPABASE_URL || process.env.REACT_APP_SUPABASE_URL;
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY || process.env.REACT_APP_SUPABASE_ANON_KEY;

const PLAN_ALLOWANCES = { almanac_pro: 3_000_000, cadence_pro: 3_000_000, cadence_plus: 8_000_000 };

function billingPeriod(profile, now) {
  if (profile?.current_period_end) {
    const end = new Date(profile.current_period_end);
    const start = new Date(end);
    start.setUTCMonth(start.getUTCMonth() - 1);
    return { start, end };
  }
  return {
    start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
  };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return res.status(500).json({ error: 'Server auth is not configured.' });
  }

  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return res.status(401).json({ error: 'Sign in required.' });
  const supabaseAuth = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: { user } = {}, error: authError } = await supabaseAuth.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Sign in required.' });

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) return res.status(500).json({ error: 'Server is not configured.' });
  const service = createClient(SUPABASE_URL, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const now = new Date();
  const { data: profile } = await service
    .from('profiles')
    .select('plans, subscription_status, current_period_end')
    .eq('user_id', user.id)
    .maybeSingle();

  const { start, end } = billingPeriod(profile, now);
  const allowance = (profile?.plans ?? []).reduce((s, p) => s + (PLAN_ALLOWANCES[p] ?? 0), 0);
  const [usageRes, grantsRes] = await Promise.all([
    service.from('usage_events').select('cost_microdollars')
      .eq('user_id', user.id)
      .gte('created_at', start.toISOString()).lt('created_at', end.toISOString()),
    service.from('credit_grants').select('amount_microdollars')
      .eq('user_id', user.id).gt('expires_at', now.toISOString()),
  ]);
  const used = (usageRes.data ?? []).reduce((s, r) => s + (r.cost_microdollars ?? 0), 0);
  const credits = (grantsRes.data ?? []).reduce((s, r) => s + (r.amount_microdollars ?? 0), 0);
  const budget = allowance + credits;

  return res.status(200).json({
    plans: profile?.plans ?? [],
    allowance_microdollars: allowance,
    credit_microdollars: credits,
    budget_microdollars: budget,
    used_microdollars: used,
    remaining_microdollars: Math.max(0, budget - used),
    percent_used: budget > 0 ? Math.min(100, Math.round((used / budget) * 100)) : 100,
    resets_at: end.toISOString(),
  });
}
