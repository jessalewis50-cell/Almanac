import { createClient } from '@supabase/supabase-js';

// ── What this function enforces ──────────────────────────────────────────────
// 1. AUTH: the caller must present a valid Supabase access token. Anything
//    else is rejected with 401 before Anthropic is ever contacted.
// 2. SHAPE: the request is rebuilt from an allowlist that matches exactly what
//    the app's three AI features send (handwriting OCR, restructure, learning
//    plans). Other models, tools, multi-turn chats, or extra fields are 400s —
//    even for a logged-in user this is not a general-purpose Claude proxy.
// 3. LOGGING: token usage is recorded per user in usage_events via the service
//    role key (clients are blocked from that table by RLS).

const ALLOWED_MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS_CAP = 8192; // highest the app uses (RestructurePanel)
const MAX_SYSTEM_CHARS = 50_000;
const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

const SUPABASE_URL =
  process.env.SUPABASE_URL || process.env.REACT_APP_SUPABASE_URL;
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY || process.env.REACT_APP_SUPABASE_ANON_KEY;

// Returns an error string, or null if the body is acceptable.
function validateBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Request body must be a JSON object.';

  const allowedKeys = new Set(['model', 'max_tokens', 'system', 'messages', 'stream']);
  for (const key of Object.keys(body)) {
    if (!allowedKeys.has(key)) return `Field "${key}" is not allowed.`;
  }

  if (body.model !== ALLOWED_MODEL) return `Model must be "${ALLOWED_MODEL}".`;

  if (!Number.isInteger(body.max_tokens) || body.max_tokens < 1 || body.max_tokens > MAX_TOKENS_CAP) {
    return `max_tokens must be an integer between 1 and ${MAX_TOKENS_CAP}.`;
  }

  if (body.system !== undefined) {
    if (typeof body.system !== 'string' || body.system.length > MAX_SYSTEM_CHARS) {
      return 'system must be a string.';
    }
  }

  if (body.stream !== undefined && typeof body.stream !== 'boolean') {
    return 'stream must be a boolean.';
  }

  // Every feature sends exactly one user message.
  if (!Array.isArray(body.messages) || body.messages.length !== 1) {
    return 'messages must contain exactly one message.';
  }
  const msg = body.messages[0];
  if (!msg || msg.role !== 'user') return 'The message role must be "user".';

  const { content } = msg;
  if (typeof content === 'string') return null;
  if (!Array.isArray(content) || content.length === 0 || content.length > 4) {
    return 'Message content must be a string or a short array of content blocks.';
  }
  for (const block of content) {
    if (!block || typeof block !== 'object') return 'Invalid content block.';
    if (block.type === 'text') {
      if (typeof block.text !== 'string') return 'Text blocks must contain a string.';
    } else if (block.type === 'image') {
      const src = block.source;
      if (!src || src.type !== 'base64' || typeof src.data !== 'string' || !ALLOWED_IMAGE_TYPES.has(src.media_type)) {
        return 'Image blocks must be base64 with a common image media type.';
      }
    } else {
      return `Content blocks of type "${block.type}" are not allowed.`;
    }
  }
  return null;
}

// Best-effort usage log — a logging failure must never fail the user's request.
async function logUsage(userId, model, usage) {
  try {
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!serviceKey || !SUPABASE_URL || !usage) return;
    const service = createClient(SUPABASE_URL, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { error } = await service.from('usage_events').insert({
      user_id: userId,
      app: 'almanac',
      model,
      input_tokens: usage.input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
      cache_read_tokens: usage.cache_read_input_tokens ?? 0,
      cache_write_tokens: usage.cache_creation_input_tokens ?? 0,
    });
    if (error) console.warn('usage_events insert failed:', error.message);
  } catch (e) {
    console.warn('usage_events insert threw:', e?.message || e);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ── 1. Authenticate the caller ────────────────────────────────────────────
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return res.status(500).json({ error: 'Server auth is not configured.' });
  }
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) {
    return res.status(401).json({ error: 'Sign in required.' });
  }
  const supabaseAuth = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: { user } = {}, error: authError } = await supabaseAuth.auth.getUser(token);
  if (authError || !user) {
    return res.status(401).json({ error: 'Sign in required.' });
  }

  // ── 2. Validate and rebuild the payload (never forward req.body as-is) ────
  const invalid = validateBody(req.body);
  if (invalid) {
    return res.status(400).json({ error: invalid });
  }
  const forwardBody = {
    model: req.body.model,
    max_tokens: req.body.max_tokens,
    ...(req.body.system !== undefined ? { system: req.body.system } : {}),
    ...(req.body.stream !== undefined ? { stream: req.body.stream } : {}),
    messages: req.body.messages,
  };

  // ── 3. Forward to Anthropic ───────────────────────────────────────────────
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(forwardBody),
    });

    const contentType = response.headers.get('content-type') || '';

    // Streaming responses arrive as server-sent events. We pipe the bytes
    // through untouched for the client, but also watch the event stream go by
    // to capture usage: input tokens ride on the first `message_start` event,
    // and the final cumulative output-token count rides on `message_delta`
    // events near the end. Only after the stream finishes do we know the
    // totals, so the usage row is written just before closing the response.
    if (contentType.includes('text/event-stream') && response.body) {
      res.status(response.status);
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');

      const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
      const decoder = new TextDecoder();
      let sseBuf = '';
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));

        sseBuf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = sseBuf.indexOf('\n')) !== -1) {
          const line = sseBuf.slice(0, nl).trim();
          sseBuf = sseBuf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          let evt;
          try { evt = JSON.parse(line.slice(5).trim()); } catch { continue; }
          if (evt.type === 'message_start' && evt.message?.usage) {
            const u = evt.message.usage;
            usage.input_tokens = u.input_tokens ?? 0;
            usage.cache_read_input_tokens = u.cache_read_input_tokens ?? 0;
            usage.cache_creation_input_tokens = u.cache_creation_input_tokens ?? 0;
          } else if (evt.type === 'message_delta' && evt.usage) {
            usage.output_tokens = evt.usage.output_tokens ?? usage.output_tokens;
          }
        }
      }
      if (response.ok) await logUsage(user.id, forwardBody.model, usage);
      res.end();
      return;
    }

    const data = await response.json();
    if (response.ok && data.usage) {
      await logUsage(user.id, forwardBody.model, data.usage);
    }
    return res.status(response.status).json(data);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
