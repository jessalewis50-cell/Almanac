import React, { useState, useRef, useCallback, useEffect } from 'react';
import './App.css';

const FONT_FAMILIES = ['Arial', 'Georgia', 'Times New Roman', 'Courier New', 'Verdana', 'Comic Sans MS'];
const FONT_SIZES = [
  { label: '10pt', value: '1' }, { label: '13pt', value: '2' }, { label: '16pt', value: '3' },
  { label: '18pt', value: '4' }, { label: '24pt', value: '5' }, { label: '32pt', value: '6' }, { label: '48pt', value: '7' },
];

function makeNote() {
  return { id: Date.now(), title: 'Untitled', content: '', strokes: [], updatedAt: new Date().toISOString() };
}
function stripHtml(h) { return h.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(); }
function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso), now = new Date();
  return d.toDateString() === now.toDateString()
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
function tbtn(active) { return `tbtn${active ? ' active' : ''}`; }

export default function App() {
  const [notes, setNotes] = useState(() => {
    try { const p = JSON.parse(localStorage.getItem('notes-v2')); if (Array.isArray(p) && p.length) return p; } catch {}
    return [makeNote()];
  });
  const [activeId, setActiveId] = useState(() => {
    try { return JSON.parse(localStorage.getItem('notes-active')); } catch { return null; }
  });
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [drawMode, setDrawMode] = useState(false);
  const [eraserActive, setEraserActive] = useState(false);
  const editorRef = useRef(null);
  const editorScrollRef = useRef(null);
  const savedRangeRef = useRef(null);
  const [formats, setFormats] = useState({});
  const [color, setColor] = useState('#000000');
  const [lined, setLined] = useState(() => {
    try { return JSON.parse(localStorage.getItem('notes-lined')) || false; } catch { return false; }
  });

  const eid = (activeId && notes.find(n => n.id === activeId)) ? activeId : notes[0]?.id;
  const activeNote = notes.find(n => n.id === eid) || notes[0];

  useEffect(() => { localStorage.setItem('notes-v2', JSON.stringify(notes)); }, [notes]);
  useEffect(() => { localStorage.setItem('notes-active', JSON.stringify(eid)); }, [eid]);
  useEffect(() => { localStorage.setItem('notes-lined', JSON.stringify(lined)); }, [lined]);

  useEffect(() => {
    if (editorRef.current) editorRef.current.innerHTML = activeNote?.content || '';
  }, [eid]); // eslint-disable-line react-hooks/exhaustive-deps

  const newNote = useCallback(() => {
    const n = makeNote(); setNotes(p => [n, ...p]); setActiveId(n.id); setSidebarOpen(false);
  }, []);

  const openNote = useCallback((id) => { setActiveId(id); setSidebarOpen(false); }, []);

  const deleteNote = useCallback((id, e) => {
    e.stopPropagation();
    setNotes(prev => {
      const rest = prev.filter(n => n.id !== id);
      if (!rest.length) { const n = makeNote(); setActiveId(n.id); return [n]; }
      if (id === eid) setActiveId(rest[0].id);
      return rest;
    });
  }, [eid]);

  const setTitle = useCallback((title) => {
    setNotes(p => p.map(n => n.id === eid ? { ...n, title, updatedAt: new Date().toISOString() } : n));
  }, [eid]);

  const onEditorInput = useCallback(() => {
    if (!editorRef.current) return;
    const content = editorRef.current.innerHTML;
    setNotes(p => p.map(n => n.id === eid ? { ...n, content, updatedAt: new Date().toISOString() } : n));
  }, [eid]);

  const saveRange = useCallback(() => {
    const sel = window.getSelection();
    if (sel?.rangeCount > 0 && editorRef.current?.contains(sel.anchorNode))
      savedRangeRef.current = sel.getRangeAt(0).cloneRange();
  }, []);

  const restoreRange = useCallback(() => {
    if (savedRangeRef.current) { const s = window.getSelection(); s.removeAllRanges(); s.addRange(savedRangeRef.current); }
    editorRef.current?.focus();
  }, []);

  const refreshFormats = useCallback(() => {
    try {
      setFormats({
        bold: document.queryCommandState('bold'), italic: document.queryCommandState('italic'),
        underline: document.queryCommandState('underline'), strikeThrough: document.queryCommandState('strikeThrough'),
        justifyLeft: document.queryCommandState('justifyLeft'), justifyCenter: document.queryCommandState('justifyCenter'),
        justifyRight: document.queryCommandState('justifyRight'),
        insertUnorderedList: document.queryCommandState('insertUnorderedList'),
        insertOrderedList: document.queryCommandState('insertOrderedList'),
      });
    } catch {}
  }, []);

  useEffect(() => {
    const h = () => { if (document.activeElement === editorRef.current) { saveRange(); refreshFormats(); } };
    document.addEventListener('selectionchange', h);
    return () => document.removeEventListener('selectionchange', h);
  }, [saveRange, refreshFormats]);

  const execBtn = useCallback((e, cmd, val = null) => {
    e.preventDefault(); document.execCommand(cmd, false, val); editorRef.current?.focus(); refreshFormats();
  }, [refreshFormats]);

  const applyFont  = useCallback((e) => { restoreRange(); document.execCommand('fontName', false, e.target.value); editorRef.current?.focus(); }, [restoreRange]);
  const applySize  = useCallback((e) => { restoreRange(); document.execCommand('fontSize', false, e.target.value); editorRef.current?.focus(); }, [restoreRange]);
  const applyColor = useCallback((e) => { const c = e.target.value; setColor(c); restoreRange(); document.execCommand('foreColor', false, c); editorRef.current?.focus(); }, [restoreRange]);

  const updateStrokes = useCallback((newStrokes) => {
    setNotes(p => p.map(n => n.id === eid
      ? { ...n, strokes: newStrokes, updatedAt: new Date().toISOString() }
      : n
    ));
  }, [eid]);

  return (
    <div className="app">
      <div className={`sidebar${sidebarOpen ? ' open' : ''}`}>
        <div className="sb-head">
          <span className="sb-heading">Notes</span>
          <button className="sb-new" onPointerDown={newNote} title="New note">＋</button>
        </div>
        <div className="sb-list">
          {notes.map(n => (
            <div key={n.id} className={`sb-note${n.id === eid ? ' active' : ''}`} onPointerDown={() => openNote(n.id)}>
              <div className="sb-note-title">{n.title || 'Untitled'}</div>
              <div className="sb-note-preview">{stripHtml(n.content).slice(0, 55) || 'No content'}</div>
              <div className="sb-note-foot">
                <span className="sb-date">{formatDate(n.updatedAt)}</span>
                <button className="sb-del" onPointerDown={e => deleteNote(n.id, e)} title="Delete">×</button>
              </div>
            </div>
          ))}
        </div>
      </div>
      {sidebarOpen && <div className="sb-overlay" onPointerDown={() => setSidebarOpen(false)} />}

      <div className="main">
        <div className="topbar">
          <button className="tbtn" onPointerDown={() => setSidebarOpen(s => !s)} title="All notes"><MenuIcon /></button>
          <input className="title-input" value={activeNote?.title || ''} onChange={e => setTitle(e.target.value)} placeholder="Untitled" />
        </div>

        <div className="toolbar" role="toolbar">
          <div className="toolbar-group">
            <select className="tb-select font-select" defaultValue="Arial" onFocus={saveRange} onChange={applyFont}>
              {FONT_FAMILIES.map(f => <option key={f} value={f}>{f}</option>)}
            </select>
            <select className="tb-select size-select" defaultValue="3" onFocus={saveRange} onChange={applySize}>
              {FONT_SIZES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </div>
          <span className="tb-div" />
          <div className="toolbar-group">
            <button className={tbtn(formats.bold)}         onPointerDown={e => execBtn(e,'bold')}         title="Bold"><b>B</b></button>
            <button className={tbtn(formats.italic)}       onPointerDown={e => execBtn(e,'italic')}       title="Italic"><i>I</i></button>
            <button className={tbtn(formats.underline)}    onPointerDown={e => execBtn(e,'underline')}    title="Underline"><u>U</u></button>
            <button className={tbtn(formats.strikeThrough)}onPointerDown={e => execBtn(e,'strikeThrough')}title="Strikethrough"><s>S</s></button>
          </div>
          <span className="tb-div" />
          <div className="toolbar-group">
            <label className="tbtn color-btn" title="Text color">
              <span className="color-a" style={{ '--c': color }}>A</span>
              <input type="color" value={color} onFocus={saveRange} onChange={applyColor} className="sr-only" />
            </label>
          </div>
          <span className="tb-div" />
          <div className="toolbar-group">
            <button className={tbtn(formats.justifyLeft)}  onPointerDown={e => execBtn(e,'justifyLeft')}  title="Left"><AlignLeftIcon /></button>
            <button className={tbtn(formats.justifyCenter)}onPointerDown={e => execBtn(e,'justifyCenter')}title="Center"><AlignCenterIcon /></button>
            <button className={tbtn(formats.justifyRight)} onPointerDown={e => execBtn(e,'justifyRight')} title="Right"><AlignRightIcon /></button>
          </div>
          <span className="tb-div" />
          <div className="toolbar-group">
            <button className={tbtn(formats.insertUnorderedList)}onPointerDown={e => execBtn(e,'insertUnorderedList')}title="Bullets"><BulletListIcon /></button>
            <button className={tbtn(formats.insertOrderedList)}  onPointerDown={e => execBtn(e,'insertOrderedList')}  title="Numbers"><span className="list-num">1.</span></button>
          </div>
          <span className="tb-div" />
          <div className="toolbar-group">
            <button className="tbtn" onPointerDown={e => execBtn(e,'outdent')} title="Decrease indent"><OutdentIcon /></button>
            <button className="tbtn" onPointerDown={e => execBtn(e,'indent')}  title="Increase indent"><IndentIcon /></button>
          </div>
          <span className="tb-div" />
          <div className="toolbar-group">
            <button className={tbtn(lined)} onPointerDown={() => setLined(l => !l)} title={lined ? 'Plain page' : 'Lined page'}><LinesIcon /></button>
          </div>
          <span className="tb-div" />
          <div className="toolbar-group">
            <button
              className={tbtn(drawMode)}
              onPointerDown={() => { setDrawMode(m => !m); setEraserActive(false); }}
              title={drawMode ? 'Switch to typing' : 'Switch to drawing'}
            >
              {drawMode ? <KeyboardIcon /> : <PenIcon />}
            </button>
            {drawMode && (
              <button
                className={tbtn(eraserActive)}
                onPointerDown={() => setEraserActive(e => !e)}
                title={eraserActive ? 'Switch to pen' : 'Eraser'}
              >
                <EraserIcon />
              </button>
            )}
          </div>
        </div>

        <div className="editor-scroll" ref={editorScrollRef}>
          <div className="editor-layer">
            <div
              ref={editorRef}
              className={`editor${lined ? ' lined' : ''}${drawMode ? ' draw-mode' : ''}`}
              contentEditable={!drawMode}
              suppressContentEditableWarning
              role="textbox"
              aria-multiline="true"
              data-placeholder="Start typing your note…"
              onInput={onEditorInput}
              onBlur={saveRange}
            />
            <DrawingCanvas
              noteId={eid}
              initialStrokes={activeNote?.strokes || []}
              onStrokesChange={updateStrokes}
              drawMode={drawMode}
              eraser={eraserActive}
              scrollElRef={editorScrollRef}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Drawing Canvas ──────────────────────────────────────────────────────────────

function DrawingCanvas({ noteId, initialStrokes, onStrokesChange, drawMode, eraser, scrollElRef }) {
  const canvasRef      = useRef(null);
  const ctxRef         = useRef(null);
  const strokesRef     = useRef([...(initialStrokes || [])]);
  const liveRef        = useRef(null);
  const isDrawingRef   = useRef(false);
  const isScrollRef    = useRef(false);
  const lastScrollYRef = useRef(0);

  // Reload strokes when the active note changes
  useEffect(() => {
    strokesRef.current = [...(initialStrokes || [])];
    redraw();
  }, [noteId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Size canvas to match its parent (.editor-layer) and redraw on resize
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    function resize() {
      const parent = canvas.parentElement;
      if (!parent) return;
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.offsetWidth;
      const h = canvas.offsetHeight;
      if (!w || !h) return;
      canvas.width  = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);
      ctxRef.current = ctx;
      redraw();
    }
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas.parentElement);
    return () => ro.disconnect();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function redraw() {
    const ctx = ctxRef.current, canvas = canvasRef.current;
    if (!ctx || !canvas) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
    for (const s of strokesRef.current) paintStroke(ctx, s.pts);
    if (liveRef.current) paintStroke(ctx, liveRef.current.pts);
  }

  function paintStroke(ctx, pts) {
    if (!pts || pts.length === 0) return;
    ctx.strokeStyle = '#1a1a2e';
    ctx.lineWidth   = 2.5;
    ctx.lineCap     = 'round';
    ctx.lineJoin    = 'round';
    if (pts.length === 1) {
      ctx.beginPath();
      ctx.arc(pts[0].x, pts[0].y, 1.25, 0, Math.PI * 2);
      ctx.fillStyle = '#1a1a2e';
      ctx.fill();
      return;
    }
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i].x + pts[i + 1].x) / 2;
      const my = (pts[i].y + pts[i + 1].y) / 2;
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
    }
    ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
    ctx.stroke();
  }

  function getPoint(e) {
    const scrollEl = scrollElRef.current;
    if (!scrollEl) return { x: 0, y: 0 };
    const rect = scrollEl.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top + scrollEl.scrollTop,
    };
  }

  function eraseAt(pt) {
    const R = 20;
    const before = strokesRef.current.length;
    strokesRef.current = strokesRef.current.filter(s =>
      !s.pts.some(p => Math.hypot(p.x - pt.x, p.y - pt.y) < R)
    );
    if (strokesRef.current.length !== before) redraw();
  }

  function onPointerDown(e) {
    if (!drawMode) return;
    const scrollEl = scrollElRef.current;
    if (!scrollEl) return;
    const rect = scrollEl.getBoundingClientRect();

    // Rightmost 20 px is a dedicated scroll strip
    if (e.clientX >= rect.right - 20) {
      isScrollRef.current   = true;
      lastScrollYRef.current = e.clientY;
      canvasRef.current.setPointerCapture(e.pointerId);
      return;
    }

    e.preventDefault();
    canvasRef.current.setPointerCapture(e.pointerId);
    isDrawingRef.current = true;
    const pt = getPoint(e);
    liveRef.current = { pts: [pt], erasing: eraser };
    if (eraser) eraseAt(pt);
    redraw();
  }

  function onPointerMove(e) {
    if (isScrollRef.current) {
      const scrollEl = scrollElRef.current;
      if (scrollEl) scrollEl.scrollTop += lastScrollYRef.current - e.clientY;
      lastScrollYRef.current = e.clientY;
      return;
    }
    if (!isDrawingRef.current || !liveRef.current) return;
    e.preventDefault();
    const pt = getPoint(e);
    liveRef.current = { ...liveRef.current, pts: [...liveRef.current.pts, pt] };
    if (eraser) eraseAt(pt);
    redraw();
  }

  function onPointerUp() {
    if (isScrollRef.current) { isScrollRef.current = false; return; }
    if (!isDrawingRef.current) return;
    isDrawingRef.current = false;

    if (liveRef.current) {
      if (!liveRef.current.erasing && liveRef.current.pts.length > 0) {
        strokesRef.current = [...strokesRef.current, { pts: liveRef.current.pts }];
      }
      onStrokesChange([...strokesRef.current]);
    }
    liveRef.current = null;
    redraw();
  }

  const cursor = !drawMode ? 'default' : eraser ? 'cell' : 'crosshair';

  return (
    <canvas
      ref={canvasRef}
      className={`draw-canvas${drawMode ? ' active' : ''}`}
      style={{ cursor }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    />
  );
}

// ── Icons ───────────────────────────────────────────────────────────────────────

function MenuIcon() {
  return <svg width="20" height="16" viewBox="0 0 20 16" fill="currentColor" aria-hidden="true">
    <rect x="0" y="0"    width="20" height="2.5" rx="1.25"/>
    <rect x="0" y="6.75" width="20" height="2.5" rx="1.25"/>
    <rect x="0" y="13.5" width="20" height="2.5" rx="1.25"/>
  </svg>;
}
function PenIcon() {
  return <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" aria-hidden="true">
    <path d="M13 2l3 3-9 9H4v-3L13 2z"/><line x1="11" y1="4" x2="14" y2="7"/>
  </svg>;
}
function KeyboardIcon() {
  return <svg width="20" height="14" viewBox="0 0 20 14" fill="currentColor" aria-hidden="true">
    <rect x="0" y="0" width="20" height="14" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5"/>
    {[0,1,2,3].map(i => <rect key={i} x={2.5+i*4} y="2.5" width="2.5" height="2.5" rx="0.5"/>)}
    {[0,1,2,3].map(i => <rect key={i} x={2.5+i*4} y="7"   width="2.5" height="2.5" rx="0.5"/>)}
    <rect x="5" y="11" width="10" height="2" rx="1"/>
  </svg>;
}
function EraserIcon() {
  return <svg width="18" height="14" viewBox="0 0 18 14" fill="currentColor" aria-hidden="true">
    <rect x="3" y="2" width="12" height="8" rx="1.5" opacity="0.85"/>
    <rect x="0" y="11.5" width="18" height="2" rx="1"/>
  </svg>;
}
function AlignLeftIcon() {
  return <svg width="18" height="14" viewBox="0 0 18 14" fill="currentColor" aria-hidden="true">
    <rect x="0" y="0"  width="18" height="2" rx="1"/><rect x="0" y="4"  width="13" height="2" rx="1"/>
    <rect x="0" y="8"  width="16" height="2" rx="1"/><rect x="0" y="12" width="10" height="2" rx="1"/>
  </svg>;
}
function AlignCenterIcon() {
  return <svg width="18" height="14" viewBox="0 0 18 14" fill="currentColor" aria-hidden="true">
    <rect x="0"   y="0"  width="18" height="2" rx="1"/><rect x="2.5" y="4"  width="13" height="2" rx="1"/>
    <rect x="1"   y="8"  width="16" height="2" rx="1"/><rect x="4"   y="12" width="10" height="2" rx="1"/>
  </svg>;
}
function AlignRightIcon() {
  return <svg width="18" height="14" viewBox="0 0 18 14" fill="currentColor" aria-hidden="true">
    <rect x="0" y="0"  width="18" height="2" rx="1"/><rect x="5" y="4"  width="13" height="2" rx="1"/>
    <rect x="2" y="8"  width="16" height="2" rx="1"/><rect x="8" y="12" width="10" height="2" rx="1"/>
  </svg>;
}
function BulletListIcon() {
  return <svg width="18" height="14" viewBox="0 0 18 14" fill="currentColor" aria-hidden="true">
    <circle cx="1.5" cy="1"  r="1.5"/><rect x="5" y="0"  width="13" height="2" rx="1"/>
    <circle cx="1.5" cy="7"  r="1.5"/><rect x="5" y="6"  width="13" height="2" rx="1"/>
    <circle cx="1.5" cy="13" r="1.5"/><rect x="5" y="12" width="13" height="2" rx="1"/>
  </svg>;
}
function IndentIcon() {
  return <svg width="18" height="14" viewBox="0 0 18 14" fill="currentColor" aria-hidden="true">
    <rect x="7" y="0"  width="11" height="2" rx="1"/>
    <rect x="7" y="6"  width="11" height="2" rx="1"/>
    <rect x="7" y="12" width="11" height="2" rx="1"/>
    <path d="M0 3L5 7L0 11Z"/>
  </svg>;
}
function OutdentIcon() {
  return <svg width="18" height="14" viewBox="0 0 18 14" fill="currentColor" aria-hidden="true">
    <rect x="7" y="0"  width="11" height="2" rx="1"/>
    <rect x="7" y="6"  width="11" height="2" rx="1"/>
    <rect x="7" y="12" width="11" height="2" rx="1"/>
    <path d="M5 3L0 7L5 11Z"/>
  </svg>;
}
function LinesIcon() {
  return <svg width="18" height="14" viewBox="0 0 18 14" fill="currentColor" aria-hidden="true">
    <rect x="0" y="0"  width="18" height="1.5" rx="0.75"/>
    <rect x="0" y="4"  width="18" height="1.5" rx="0.75"/>
    <rect x="0" y="8"  width="18" height="1.5" rx="0.75"/>
    <rect x="0" y="12" width="18" height="1.5" rx="0.75"/>
  </svg>;
}
