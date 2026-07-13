// Cross-note search + in-note find logic.
//
// Search scope: the `notes` array in App state — for signed-in users that is
// the full set loaded by loadAll(); in guest mode it IS the notes-v2
// localStorage set (loaded at guest entry). Linear scan over stripped text is
// fine for personal note counts; if this ever needs to scale, the upgrade
// path is Supabase full-text search (tsvector on notes.content).

import { htmlToPlainText } from './learningPlan';

export function tokenizeQuery(query) {
  return String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * Case-insensitive multi-word AND search over title + stripped text.
 * Returns [{ id, title, count, snippet: { before, match, after } }],
 * sorted by match count descending.
 */
export function searchNotes(notes, query) {
  const tokens = tokenizeQuery(query);
  if (!tokens.length) return [];
  const results = [];
  for (const n of notes) {
    const title = n.title || '';
    const text = htmlToPlainText(n.content);
    const orig = (title + '\n' + text).replace(/\n+/g, ' ');
    const hay = orig.toLowerCase();
    if (!tokens.every(t => hay.includes(t))) continue; // AND semantics

    let count = 0, firstPos = -1, firstLen = 0;
    for (const t of tokens) {
      let i = hay.indexOf(t);
      while (i !== -1) {
        count++;
        if (firstPos === -1 || i < firstPos) { firstPos = i; firstLen = t.length; }
        i = hay.indexOf(t, i + t.length);
      }
    }
    const start = Math.max(0, firstPos - 32);
    const end = Math.min(orig.length, firstPos + firstLen + 48);
    results.push({
      id: n.id,
      title: title || 'Untitled',
      count,
      snippet: {
        before: (start > 0 ? '…' : '') + orig.slice(start, firstPos),
        match: orig.slice(firstPos, firstPos + firstLen),
        after: orig.slice(firstPos + firstLen, end) + (end < orig.length ? '…' : ''),
      },
    });
  }
  return results.sort((a, b) => b.count - a.count);
}

/**
 * All token occurrences in the editor's plain text (quill.getText()), as
 * sorted, non-overlapping { index, length } ranges in Quill coordinates.
 */
export function findMatches(text, query) {
  const tokens = tokenizeQuery(query);
  const hay = String(text || '').toLowerCase();
  const all = [];
  for (const t of tokens) {
    let i = hay.indexOf(t);
    while (i !== -1) { all.push({ index: i, length: t.length }); i = hay.indexOf(t, i + t.length); }
  }
  all.sort((a, b) => a.index - b.index || b.length - a.length);
  const out = [];
  let lastEnd = -1;
  for (const m of all) {
    if (m.index < lastEnd) continue; // drop overlaps between tokens
    out.push(m);
    lastEnd = m.index + m.length;
  }
  return out;
}

/**
 * Belt-and-suspenders guard for persistence: remove any search-highlight
 * markup (ql-sh-* classes from the dedicated attributor) from HTML about to
 * be serialized/saved. The highlights are applied with 'silent' so autosave
 * never fires from them, but a user keystroke while highlights are visible
 * serializes the live editor DOM — this makes sure what gets stored is clean.
 */
export function stripSearchHighlights(html) {
  const s = String(html || '');
  if (!s.includes('ql-sh-')) return s; // fast path: nothing to strip
  const doc = new DOMParser().parseFromString(s, 'text/html');
  doc.body.querySelectorAll('[class*="ql-sh-"]').forEach(el => {
    el.classList.remove('ql-sh-on', 'ql-sh-active');
    if (!el.getAttribute('class')) el.removeAttribute('class');
    if (el.tagName === 'SPAN' && el.attributes.length === 0) {
      while (el.firstChild) el.parentNode.insertBefore(el.firstChild, el);
      el.remove();
    }
  });
  return doc.body.innerHTML;
}
