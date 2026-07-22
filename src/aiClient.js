// Thin client for the app's existing Anthropic proxy path — the same one the
// handwriting feature uses. No key lives here; it's attached server-side:
//   dev  → src/setupProxy.js forwards /api/anthropic/* to api.anthropic.com
//   prod → vercel.json rewrites /api/anthropic/v1/messages to api/anthropic.js
//
// Loading is caller-driven: wrap the returned promise (and onText for streams)
// in your own state, the way convertDrawingToText does with `converting`.

import { supabase } from './supabaseClient';

const ENDPOINT = '/api/anthropic/v1/messages';
export const AI_MODEL = 'claude-sonnet-4-6'; // same model as the handwriting feature

const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 700;

export class AIError extends Error {
  constructor(message, { status = 0, retryable = false, cause } = {}) {
    super(message);
    this.name = 'AIError';
    this.status = status;       // HTTP status, 0 for network failures
    this.retryable = retryable; // whether withRetry may re-attempt
    if (cause) this.cause = cause;
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(t);
        reject(new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    }
  });
}

// 408 timeout, 429 rate limit, 529 overloaded, 5xx — worth a retry; 4xx is not.
function isRetryableStatus(s) {
  return s === 408 || s === 429 || s === 529 || (s >= 500 && s < 600);
}

async function parseErrorResponse(response) {
  let detail = '';
  let code = null;
  try {
    const data = await response.json();
    detail = data?.error?.message || data?.error || '';
    code = data?.code || null;
  } catch {
    try { detail = await response.text(); } catch {}
  }
  // The server's upgrade/limit notices are already user-facing copy — verbatim.
  if ((code === 'upgrade_required' || code === 'limit_reached') && detail) return detail;
  return detail ? `AI request failed (${response.status}): ${detail}` : `AI request failed (HTTP ${response.status})`;
}

/**
 * Authorization header carrying the signed-in user's Supabase access token.
 * The serverless proxy verifies it before forwarding anything to Anthropic.
 * Throws a friendly AIError when there is no session (e.g. guest mode).
 */
export async function authHeaders() {
  const { data: { session } = {} } = await supabase.auth.getSession();
  if (!session?.access_token) {
    throw new AIError('Please sign in to use AI features.', { status: 401, retryable: false });
  }
  return { Authorization: `Bearer ${session.access_token}` };
}

async function request(body, { signal, endpoint = ENDPOINT } = {}) {
  const auth = await authHeaders();
  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new AIError('Network error — check your connection and try again.', { retryable: true, cause: err });
  }
  if (!response.ok) {
    throw new AIError(await parseErrorResponse(response), {
      status: response.status,
      retryable: isRetryableStatus(response.status),
    });
  }
  return response;
}

async function withRetry(fn, { signal, onRetry } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      lastErr = err;
      const retryable = err instanceof AIError && err.retryable;
      if (!retryable || attempt === MAX_ATTEMPTS) throw err;
      if (onRetry) onRetry(attempt, err);
      await sleep(RETRY_BASE_MS * attempt, signal);
    }
  }
  throw lastErr; // unreachable, but keeps intent explicit
}

function buildBody({ system, content, model, maxTokens }) {
  return {
    model: model || AI_MODEL,
    max_tokens: maxTokens || 1024,
    ...(system ? { system } : {}),
    // `content` may be a plain string or an Anthropic content-block array
    // (e.g. image + text, as the handwriting feature sends).
    messages: [{ role: 'user', content }],
  };
}

/**
 * One-shot completion. Resolves to the response text.
 * Retries transient failures (network, 429/5xx/529) up to 3 attempts.
 *
 * aiComplete({ system, content, model?, maxTokens?, signal?, onRetry?, endpoint? })
 */
export async function aiComplete(opts) {
  const body = buildBody(opts);
  return withRetry(async () => {
    const response = await request(body, opts);
    const data = await response.json();
    return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  }, opts);
}

/**
 * Streaming completion. Calls onText(delta, fullSoFar) as text arrives and
 * resolves to the full text. Retries only failures that happen BEFORE any
 * text has been received — once tokens have flowed, retrying would duplicate
 * output, so later failures surface as non-retryable AIErrors.
 *
 * aiStream({ system, content, onText, model?, maxTokens?, signal?, onRetry?, endpoint? })
 */
export async function aiStream(opts) {
  const body = { ...buildBody(opts), stream: true };
  const { onText, signal } = opts;

  return withRetry(async () => {
    const response = await request(body, opts);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let full = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          let evt;
          try { evt = JSON.parse(payload); } catch { continue; }
          if (evt.type === 'content_block_delta' && evt.delta && evt.delta.type === 'text_delta') {
            full += evt.delta.text;
            if (onText) onText(evt.delta.text, full);
          } else if (evt.type === 'error') {
            throw new AIError(`AI stream error: ${evt.error?.message || 'unknown'}`, { retryable: false });
          }
        }
      }
    } catch (err) {
      if (err.name === 'AbortError' || err instanceof AIError) throw err;
      // Connection dropped mid-stream: retrying would replay text already shown.
      throw new AIError('Connection lost while streaming the AI response.', {
        retryable: full.length === 0,
        cause: err,
      });
    } finally {
      reader.releaseLock();
    }
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    return full;
  }, opts);
}
