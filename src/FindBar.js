import React, { useCallback, useEffect, useRef, useState } from 'react';
import { findMatches } from './noteSearch';

// ── Cross-note results list (rendered inside the sidebar) ──────────────────

export function SearchResults({ results, onOpen }) {
  if (!results.length) return <div className="sr-empty">No matching notes</div>;
  return (
    <>
      {results.map(r => (
        <div key={r.id} className="sr-row" onPointerDown={() => onOpen(r.id)}>
          <div className="sr-title-line">
            <span className="sr-title">{r.title}</span>
            <span className="sr-count">{r.count}</span>
          </div>
          <div className="sr-snippet">
            {r.snippet.before}<span className="sr-mark">{r.snippet.match}</span>{r.snippet.after}
          </div>
        </div>
      ))}
    </>
  );
}

// ── In-note find bar (Word-style find-next) ────────────────────────────────
// All highlight formatting uses the dedicated 'search-highlight' attributor
// and Quill's 'silent' source, so no text-change fires and autosave never
// sees these spans (noteSearch.stripSearchHighlights guards serialization
// as a second layer).
//
// Scrolling uses quill.getBounds + the scroll container rather than
// quill.setSelection: setSelection re-focuses the editor asynchronously,
// which steals the keyboard from the find bar and turns Enter into a
// newline in the note. With geometric scrolling, focus stays in the bar.

function scrollMatchIntoView(quill, m) {
  const bounds = quill.getBounds(m.index, m.length);
  if (!bounds) return;
  const scroller = quill.root.closest('.editor-scroll');
  if (!scroller) return;
  const contTop = quill.container.getBoundingClientRect().top;
  const scrTop = scroller.getBoundingClientRect().top;
  const yInContent = scroller.scrollTop + (contTop - scrTop) + bounds.top;
  scroller.scrollTop = Math.max(0, yInContent - scroller.clientHeight / 2);
}

export function FindBar({ quillRef, contentKey, initialQuery, onClose }) {
  const [text, setText] = useState(initialQuery);
  const [query, setQuery] = useState(initialQuery); // debounced
  const [matches, setMatches] = useState([]);
  const [active, setActive] = useState(0);
  const inputRef = useRef(null);
  const matchesRef = useRef([]);
  const activeRef = useRef(0);

  const getQuill = useCallback(() => quillRef.current && quillRef.current.getEditor(), [quillRef]);


  const clearAll = useCallback(() => {
    const quill = getQuill();
    if (quill) quill.formatText(0, quill.getLength(), 'search-highlight', false, 'silent');
  }, [getQuill]);

  const activate = useCallback((i) => {
    const quill = getQuill();
    const ms = matchesRef.current;
    if (!quill || !ms.length) return;
    const prev = ms[activeRef.current];
    if (prev) quill.formatText(prev.index, prev.length, 'search-highlight', 'on', 'silent');
    const m = ms[i];
    quill.formatText(m.index, m.length, 'search-highlight', 'active', 'silent');
    scrollMatchIntoView(quill, m);
    activeRef.current = i;
    setActive(i);
  }, [getQuill]);

  const next = useCallback(() => {
    const len = matchesRef.current.length;
    if (len) activate((activeRef.current + 1) % len); // wrap-around
  }, [activate]);

  const prevMatch = useCallback(() => {
    const len = matchesRef.current.length;
    if (len) activate((activeRef.current - 1 + len) % len);
  }, [activate]);

  // Debounce refinements typed into the bar
  useEffect(() => {
    const t = setTimeout(() => setQuery(text), 250);
    return () => clearTimeout(t);
  }, [text]);

  // Apply highlights when the query or the underlying note changes.
  // Deferred a tick so it runs after App's eid effect has pasted note content.
  useEffect(() => {
    const t = setTimeout(() => {
      const quill = getQuill();
      if (!quill) return;
      clearAll();
      const ms = query.trim() ? findMatches(quill.getText(), query) : [];
      ms.forEach(m => quill.formatText(m.index, m.length, 'search-highlight', 'on', 'silent'));
      matchesRef.current = ms;
      activeRef.current = 0;
      setMatches(ms);
      setActive(0);
      if (ms.length) {
        const m = ms[0];
        quill.formatText(m.index, m.length, 'search-highlight', 'active', 'silent');
        scrollMatchIntoView(quill, m);
        if (inputRef.current) inputRef.current.focus();
      }
    }, 30);
    return () => clearTimeout(t);
  }, [query, contentKey, getQuill, clearAll]);

  // Remove every highlight when the bar closes/unmounts.
  useEffect(() => clearAll, [clearAll]);

  // F3 / Shift+F3 globally while the bar is open; Escape closes.
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'F3') { e.preventDefault(); e.shiftKey ? prevMatch() : next(); }
      else if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [next, prevMatch, onClose]);

  function onInputKey(e) {
    if (e.key === 'Enter') { e.preventDefault(); e.shiftKey ? prevMatch() : next(); }
  }

  useEffect(() => { if (inputRef.current) inputRef.current.focus(); }, []);

  return (
    <div className="findbar">
      <input
        ref={inputRef}
        className="findbar-input"
        value={text}
        onChange={e => setText(e.target.value)}
        onKeyDown={onInputKey}
        placeholder="Find in note…"
      />
      <span className="findbar-count">
        {matches.length ? `${active + 1} of ${matches.length}` : '0 of 0'}
      </span>
      <button className="findbar-btn" onPointerDown={prevMatch} disabled={!matches.length} title="Previous (Shift+Enter / Shift+F3)">‹</button>
      <button className="findbar-btn" onPointerDown={next} disabled={!matches.length} title="Next (Enter / F3)">›</button>
      <button className="findbar-btn findbar-close" onPointerDown={onClose} title="Close (Esc)">×</button>
    </div>
  );
}
