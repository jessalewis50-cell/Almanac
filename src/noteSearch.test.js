// Unit tests for the pure search/find logic in noteSearch.js.
// These import no component and no env-dependent module (Supabase, aiClient),
// so they run cleanly. stripSearchHighlights uses DOMParser, which jsdom
// (CRA's default test environment) provides.

import {
  tokenizeQuery,
  searchNotes,
  findMatches,
  stripSearchHighlights,
} from './noteSearch';

// ── tokenizeQuery ──────────────────────────────────────────────────────────
describe('tokenizeQuery', () => {
  test('lowercases and splits on whitespace, dropping empties', () => {
    expect(tokenizeQuery('  useState  Hook ')).toEqual(['usestate', 'hook']);
  });

  test('returns [] for empty / nullish input', () => {
    expect(tokenizeQuery('')).toEqual([]);
    expect(tokenizeQuery('   ')).toEqual([]);
    expect(tokenizeQuery(null)).toEqual([]);
    expect(tokenizeQuery(undefined)).toEqual([]);
  });
});

// ── searchNotes ────────────────────────────────────────────────────────────
describe('searchNotes', () => {
  const notes = [
    { id: 'a', title: 'React hooks', content: '<p>useState and useEffect. useState again.</p>' },
    { id: 'b', title: 'Cooking', content: '<p>Boil the pasta, then add sauce.</p>' },
    { id: 'c', title: 'Notes on state', content: '<p>Application <b>state</b> management. State state.</p>' },
  ];

  test('empty query returns no results', () => {
    expect(searchNotes(notes, '')).toEqual([]);
    expect(searchNotes(notes, '   ')).toEqual([]);
  });

  test('counts every occurrence across title + stripped body', () => {
    const res = searchNotes(notes, 'state');
    const c = res.find(r => r.id === 'c');
    // title "Notes on state" (1) + body "state", "State", "state" (3) = 4
    expect(c.count).toBe(4);
  });

  test('is case-insensitive and matches substrings (Word-style Find default)', () => {
    // "state" appears inside "useState" twice in note a
    const res = searchNotes(notes, 'usestate');
    expect(res.map(r => r.id)).toContain('a');
    expect(res.find(r => r.id === 'a').count).toBe(2);
  });

  test('sorts results by match count descending', () => {
    const res = searchNotes(notes, 'state');
    expect(res.map(r => r.id)).toEqual(['c', 'a']); // c(4) before a(2), b excluded
  });

  test('multi-word queries use AND semantics', () => {
    // Only note c contains both "state" AND "management"
    const res = searchNotes(notes, 'state management');
    expect(res.map(r => r.id)).toEqual(['c']);
  });

  test('returns a snippet around the first match', () => {
    const res = searchNotes(notes, 'pasta');
    expect(res).toHaveLength(1);
    expect(res[0].snippet.match.toLowerCase()).toBe('pasta');
    expect(res[0].snippet.before + res[0].snippet.match + res[0].snippet.after)
      .toMatch(/pasta/i);
  });

  test('falls back to "Untitled" when a note has no title', () => {
    const res = searchNotes([{ id: 'x', title: '', content: '<p>zebra</p>' }], 'zebra');
    expect(res[0].title).toBe('Untitled');
  });

  test('no match returns empty array', () => {
    expect(searchNotes(notes, 'xylophone')).toEqual([]);
  });

  test('snippet is drawn from the body only — never prefixed with the title', () => {
    const res = searchNotes(
      [{ id: 'n', title: 'Untitled', content: '<p>test note</p>' }],
      'tes'
    );
    const snip = res[0].snippet;
    const full = snip.before + snip.match + snip.after;
    expect(full).not.toMatch(/Untitled/);   // title must not leak into the snippet
    expect(full).toMatch(/test note/);       // body context is preserved
    expect(snip.before).toBe('');            // match is at the start of the body
  });

  test('title-only match still surfaces the note, with a body lead-in snippet', () => {
    const res = searchNotes(
      [{ id: 'n', title: 'Groceries', content: '<p>milk and eggs</p>' }],
      'groceries'
    );
    expect(res).toHaveLength(1);
    expect(res[0].snippet.match).toBe('');           // no body match to highlight
    expect(res[0].snippet.after).toMatch(/milk and eggs/);
  });
});

// ── findMatches ────────────────────────────────────────────────────────────
describe('findMatches', () => {
  test('finds every occurrence, case-insensitively, with correct ranges', () => {
    expect(findMatches('state STATE StAtE xstatex', 'state')).toEqual([
      { index: 0, length: 5 },
      { index: 6, length: 5 },
      { index: 12, length: 5 },
      { index: 19, length: 5 },
    ]);
  });

  test('produces non-overlapping ranges for repeating patterns', () => {
    // "aa" in "aaaa" must be [0,2), [2,4) — not [0,2),[1,3),[2,4)
    expect(findMatches('aaaa', 'aa')).toEqual([
      { index: 0, length: 2 },
      { index: 2, length: 2 },
    ]);
  });

  test('empty / whitespace query yields no matches', () => {
    expect(findMatches('anything here', '')).toEqual([]);
    expect(findMatches('anything here', '   ')).toEqual([]);
  });

  test('multi-token matches are merged in document order', () => {
    const res = findMatches('foo bar foo', 'foo bar');
    expect(res).toEqual([
      { index: 0, length: 3 },  // foo
      { index: 4, length: 3 },  // bar
      { index: 8, length: 3 },  // foo
    ]);
  });
});

// ── stripSearchHighlights ──────────────────────────────────────────────────
describe('stripSearchHighlights', () => {
  test('fast-path returns input unchanged when no highlight markup present', () => {
    const html = '<p>hello <strong>world</strong></p>';
    expect(stripSearchHighlights(html)).toBe(html);
  });

  test('unwraps highlight-only spans, leaving text intact', () => {
    const out = stripSearchHighlights('<p>a <span class="ql-sh-active">match</span> b</p>');
    expect(out).toContain('match');
    expect(out).not.toContain('ql-sh');
    expect(out).not.toContain('<span');
  });

  test("preserves the user's own formatting on a co-formatted element", () => {
    // A span that carries both a highlight class and a real font class must
    // keep the font class after the highlight is stripped.
    const out = stripSearchHighlights('<p><span class="ql-font-arial ql-sh-on">hi</span></p>');
    expect(out).toContain('ql-font-arial');
    expect(out).not.toContain('ql-sh');
  });

  test('handles nullish input', () => {
    expect(stripSearchHighlights(null)).toBe('');
    expect(stripSearchHighlights(undefined)).toBe('');
  });
});
