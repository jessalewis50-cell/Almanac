// Learning-plan feature logic: prompt construction, defensive JSON parsing,
// and conversion between Quill HTML and plain text / plan HTML.
// UI lives in LearningPlanPanel.js; the network call goes through aiClient.js.

const PER_NOTE_CHAR_CAP = 12000;
const TOTAL_CHAR_CAP = 24000;

const PLAN_SCHEMA_EXAMPLE = `{
  "title": "string",
  "estimatedTotalHours": 0,
  "milestones": [
    {
      "name": "string",
      "order": 0,
      "objective": "string",
      "topics": ["string"],
      "activities": ["string"],
      "checkpoint": "string",
      "estimatedHours": 0
    }
  ],
  "spacedRepetitionSuggestions": ["string"]
}`;

export const PLAN_SYSTEM_PROMPT = [
  'You are a learning-plan designer.',
  'When notes are provided, base the plan strictly on their actual content — extract the real topics, terms, and skills that appear in them; do not produce a generic curriculum that ignores the notes. When no notes are provided, design the plan from the learner\'s own description of what they want to learn.',
  'Order milestones from foundational to advanced, with "order" starting at 1.',
  'Each milestone\'s estimatedHours must be realistic, and the milestone hours should sum to approximately estimatedTotalHours.',
  'Respect the learner parameters (level, weekly time, deadline, goal) when they are given.',
  'Return ONLY a single JSON object exactly matching this schema — no prose, no explanations, no markdown fences:',
  PLAN_SCHEMA_EXAMPLE,
].join('\n');

/** Quill HTML → readable plain text (lists become "- " lines, blocks become newlines). */
export function htmlToPlainText(html) {
  let s = String(html || '');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<li[^>]*>/gi, '\n- ');
  s = s.replace(/<\/(p|div|h[1-6]|blockquote|tr|ul|ol|li)>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  if (typeof document !== 'undefined') {
    // Entity decoding only. Safe against XSS by construction: all tags were
    // stripped above, <textarea> treats its content as raw text (no script
    // execution or resource loads), the element is never attached to the DOM,
    // and the decoded value is used strictly as plain text downstream.
    const ta = document.createElement('textarea');
    ta.innerHTML = s;
    s = ta.value;
  } else {
    s = s.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
         .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#0?39;/g, "'");
  }
  return s.replace(/ /g, ' ')
    .split('\n').map(l => l.replace(/\s+/g, ' ').trim())
    .join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export const PLAN_ADJUST_SYSTEM_PROMPT = [
  'You are adjusting an existing learning plan at the user\'s request.',
  'Apply ONLY the requested changes; keep every other milestone and field as stable as possible (same names, order, wording) so the user can see exactly what changed.',
  'Stay grounded: do not introduce topics that are in neither the original material nor the user\'s request.',
  'Return ONLY a single JSON object exactly matching this schema — no prose, no explanations, no markdown fences:',
  PLAN_SCHEMA_EXAMPLE,
].join('\n');

/** Content for an adjustment turn: original material + current plan + request. */
export function buildPlanAdjustContent(baseContent, plan, request) {
  return [
    baseContent ? `ORIGINAL REQUEST AND MATERIAL:\n${String(baseContent).slice(0, 12000)}` : '',
    `CURRENT PLAN (JSON):\n${JSON.stringify(plan)}`,
    `REQUESTED ADJUSTMENT:\n${request}`,
    'Return the full revised plan JSON now.',
  ].filter(Boolean).join('\n\n');
}

/**
 * Build the user-turn content. Notes are optional: a plan can be grounded in
 * selected notes, in the learner's free-text description, or both.
 */
export function buildPlanUserContent(sources, { comments } = {}) {
  let remaining = TOTAL_CHAR_CAP;
  const blocks = [];
  for (const s of sources) {
    if (remaining <= 0) break;
    const text = s.text.slice(0, Math.min(PER_NOTE_CHAR_CAP, remaining));
    remaining -= text.length;
    blocks.push(`--- Note: ${s.title} ---\n${text}`);
  }

  return [
    comments && comments.trim() ? `LEARNER'S REQUEST (in their own words):\n${comments.trim()}` : '',
    blocks.length ? `NOTES TO BASE THE PLAN ON:\n${blocks.join('\n\n')}` : '',
    'Create the learning plan now. Respond with the JSON object only.',
  ].filter(Boolean).join('\n\n');
}

const toStr = v => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v));
const toNum = v => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.round(n * 10) / 10 : 0; };
const toStrArray = v => (Array.isArray(v) ? v.map(toStr).filter(Boolean) : []);

/**
 * Parse the model output into a schema-shaped plan. Tolerates markdown fences
 * and stray prose around the JSON; coerces/defaults every field so the UI can
 * render whatever survives. Throws Error with a user-readable message.
 */
export function parsePlan(raw) {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('The AI returned an empty response — please try again.');
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('The AI response did not contain a JSON plan — please try again.');
  let data;
  try { data = JSON.parse(s.slice(start, end + 1)); }
  catch { throw new Error('The AI response could not be parsed as JSON — please try again.'); }

  const milestones = (Array.isArray(data.milestones) ? data.milestones : [])
    .map((m, i) => ({
      name: toStr(m && m.name) || `Milestone ${i + 1}`,
      order: Number.isFinite(Number(m && m.order)) ? Number(m.order) : i + 1,
      objective: toStr(m && m.objective),
      topics: toStrArray(m && m.topics),
      activities: toStrArray(m && m.activities),
      checkpoint: toStr(m && m.checkpoint),
      estimatedHours: toNum(m && m.estimatedHours),
    }))
    .sort((a, b) => a.order - b.order);

  if (!milestones.length) throw new Error('The AI plan contained no milestones — please try again.');

  const summed = milestones.reduce((acc, m) => acc + m.estimatedHours, 0);
  return {
    title: toStr(data.title) || 'Learning Plan',
    estimatedTotalHours: toNum(data.estimatedTotalHours) || Math.round(summed * 10) / 10,
    milestones,
    spacedRepetitionSuggestions: toStrArray(data.spacedRepetitionSuggestions),
  };
}

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Plan → Quill-compatible HTML for "save as note". Uses only formats the
 * editor whitelists (bold/italic/underline/list/size), so nothing is stripped
 * when the note is opened.
 */
export function planToNoteHtml(plan) {
  const parts = [];
  parts.push(`<p><span style="font-size: 20pt"><strong>${esc(plan.title)}</strong></span></p>`);
  parts.push(`<p><em>Estimated total: ${esc(plan.estimatedTotalHours)} hours</em></p>`);
  parts.push('<p><br></p>');
  for (const m of plan.milestones) {
    parts.push(`<p><span style="font-size: 16pt"><strong>${esc(m.order)}. ${esc(m.name)}</strong></span> — ~${esc(m.estimatedHours)}h</p>`);
    if (m.objective) parts.push(`<p><em>Objective:</em> ${esc(m.objective)}</p>`);
    if (m.topics.length) {
      parts.push('<p><u>Topics</u></p>');
      parts.push(`<ul>${m.topics.map(t => `<li>${esc(t)}</li>`).join('')}</ul>`);
    }
    if (m.activities.length) {
      parts.push('<p><u>Activities</u></p>');
      parts.push(`<ul>${m.activities.map(a => `<li>${esc(a)}</li>`).join('')}</ul>`);
    }
    if (m.checkpoint) parts.push(`<p><em>Checkpoint:</em> ${esc(m.checkpoint)}</p>`);
    parts.push('<p><br></p>');
  }
  if (plan.spacedRepetitionSuggestions.length) {
    parts.push('<p><span style="font-size: 16pt"><strong>Spaced repetition</strong></span></p>');
    parts.push(`<ul>${plan.spacedRepetitionSuggestions.map(s => `<li>${esc(s)}</li>`).join('')}</ul>`);
  }
  return parts.join('');
}
