// Restructure-note feature logic: purpose templates, prompt construction,
// purpose inference, and sanitization of model HTML down to the exact subset
// Quill's editor supports. UI lives in RestructurePanel.js.

export const PURPOSES = [
  {
    id: 'tidy',
    label: 'Just tidy it up',
    template:
      'Keep the existing content and its overall order. Only: group related items together, ' +
      'add short bold section labels where a group clearly needs one, normalize list formatting, ' +
      'and merge duplicate or fragmented lines. Change as little as possible.',
  },
  {
    id: 'exam',
    label: 'Exam prep',
    template:
      'Active-recall format. Start with a brief summary section of the key points. Then convert ' +
      'the material into question-and-answer pairs: each question in bold on its own line, the ' +
      'answer below it, grouped by subtopic with a sized heading per group. End with a short ' +
      '"High-yield facts" list of the most testable items.',
  },
  {
    id: 'writing',
    label: 'Writing / essay',
    template:
      'Thesis-first outline. Open with the strongest central claim that is actually present in ' +
      'the note as the thesis. Then group the remaining material into supporting arguments, each ' +
      'with a sized heading and its evidence as bullets beneath it. Include a counterpoints ' +
      'section only if the note contains opposing points.',
  },
  {
    id: 'reference',
    label: 'Quick reference',
    template:
      'Scannable cheat sheet. Short bold headers, tight bullet lists, key terms in bold at the ' +
      'start of each bullet. Prefer fragments over full sentences. Optimize for lookup speed, ' +
      'not reading flow.',
  },
  {
    id: 'understanding',
    label: 'Deep understanding',
    template:
      'Concept-first progression. Identify the most fundamental concept in the note and start ' +
      'there; each subsequent section builds on the previous one and states explicitly which ' +
      'earlier concept it depends on. Surface-level details come last.',
  },
  {
    id: 'teach',
    label: 'Teach it to someone',
    template:
      'Teaching order, simplest first. Rewrite each section as a plain-language explanation a ' +
      'newcomer could follow. You may add brief analogies, clearly phrased as analogies, but ' +
      'they must only restate ideas already in the note — never new factual claims. End each ' +
      'section with a one-line recap in italics.',
  },
];

/** Cheap local heuristic to pre-select a likely purpose; the user can override. */
export function inferPurpose(text) {
  const t = String(text || '').toLowerCase();
  if (/\b(exam|test|quiz|midterm|final|memoriz|study for|revision)\b/.test(t)) return 'exam';
  if (/\b(essay|thesis|argument|draft|paper|intro paragraph|conclusion)\b/.test(t)) return 'writing';
  if (/\b(command|shortcut|syntax|cheat ?sheet|config|api|hotkey|steps to)\b/.test(t)) return 'reference';
  if (/\b(concept|theory|principle|understand|intuition|derivation|why does)\b/.test(t)) return 'understanding';
  if (/\b(teach|explain to|lesson|present(ation)?|tutor|onboard)\b/.test(t)) return 'teach';
  return 'tidy';
}

const HTML_RULES = [
  'OUTPUT FORMAT: return ONLY the restructured note as HTML. No markdown, no code fences, no commentary before or after.',
  'Allowed tags, and nothing else: <p>, <br>, <strong>, <em>, <u>, <ul>, <ol>, <li>, and <span style="font-size: 20pt"> or <span style="font-size: 16pt"> for section headings (put <strong> inside the span). No <h1>-<h6>, no <table>, no <a>, no <img>, no <div>, no classes, no other attributes.',
  'Headings pattern: <p><span style="font-size: 16pt"><strong>Section name</strong></span></p>',
].join('\n');

const FIDELITY_RULES = [
  'FIDELITY — this is critical: use ONLY information that is actually present in the note.',
  'You may reorder, group, retitle sections, deduplicate, tighten wording, and convert prose to lists or Q&A.',
  'You may flag gaps with a line like <p><em>[Gap: X is mentioned but never explained]</em></p>.',
  'You must NOT invent facts, definitions, numbers, examples, or details that the note does not contain.',
].join('\n');

export function buildRestructureSystemPrompt(purposeId, freeform) {
  const p = PURPOSES.find(x => x.id === purposeId) || PURPOSES[0];
  return [
    'You restructure a user\'s note so the same content serves a specific purpose better.',
    FIDELITY_RULES,
    HTML_RULES,
    `RESTRUCTURING PURPOSE — ${p.label}:`,
    p.template,
    freeform ? `ADDITIONAL USER INSTRUCTIONS (obey within the fidelity rules): ${freeform}` : '',
  ].filter(Boolean).join('\n\n');
}

export function buildRestructureUserContent(title, text) {
  return `Note title: ${title || 'Untitled'}\n\nNOTE CONTENT:\n${text}\n\nReturn the restructured note as HTML now.`;
}

// ── Sanitizer ────────────────────────────────────────────────────────────────
// Reduces model output to the exact tag set above. Everything else is unwrapped
// (children kept, tag dropped); script/style subtrees are removed entirely; ALL
// attributes are dropped except a validated font-size on <span>. Output is safe
// for dangerouslySetInnerHTML in the preview and clean for Quill's clipboard.

const KEEP = new Set(['P', 'BR', 'STRONG', 'EM', 'U', 'UL', 'OL', 'LI', 'SPAN']);
const DROP_WITH_CHILDREN = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META', 'TITLE']);
const SIZE_OK = /^(?:10|12|14|16|18|20|22|24|26|28)pt$/;

const escText = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function sanitizeQuillHtml(raw) {
  let s = String(raw || '').trim();
  const fence = s.match(/```(?:html)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  // Drop any prose before the first tag / after the last closing tag.
  const first = s.indexOf('<');
  const last = s.lastIndexOf('>');
  if (first === -1 || last <= first) throw new Error('The AI did not return HTML — please try again.');
  s = s.slice(first, last + 1);

  const doc = new DOMParser().parseFromString(s, 'text/html');

  function serialize(node) {
    if (node.nodeType === Node.TEXT_NODE) return escText(node.textContent);
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    let tag = node.tagName;
    if (DROP_WITH_CHILDREN.has(tag)) return '';
    if (tag === 'B') tag = 'STRONG';
    if (tag === 'I') tag = 'EM';
    const children = Array.from(node.childNodes).map(serialize).join('');
    // Headings the model slips through become sized bold paragraphs.
    if (/^H[1-6]$/.test(tag)) {
      const size = tag === 'H1' ? '20pt' : '16pt';
      return `<p><span style="font-size: ${size}"><strong>${children}</strong></span></p>`;
    }
    if (!KEEP.has(tag)) return children; // unwrap unknown tags, keep their text
    if (tag === 'BR') return '<br>';
    if (tag === 'SPAN') {
      const m = (node.getAttribute('style') || '').match(/font-size:\s*(\d+pt)/i);
      if (m && SIZE_OK.test(m[1])) return `<span style="font-size: ${m[1]}">${children}</span>`;
      return children; // spans without a valid size are unwrapped
    }
    const t = tag.toLowerCase();
    return `<${t}>${children}</${t}>`;
  }

  const out = Array.from(doc.body.childNodes).map(serialize).join('');
  if (!out.replace(/<[^>]+>/g, '').trim()) throw new Error('The AI returned an empty result — please try again.');
  return out;
}
