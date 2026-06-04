import React, { useState, useRef, useCallback, useEffect, useImperativeHandle } from 'react';
import './App.css';
import { supabase } from './supabaseClient';
import { motion, useAnimation } from 'framer-motion';
import ReactQuill from 'react-quill-new';
import 'react-quill-new/dist/quill.snow.css';
import Quill from 'quill';

// Use inline-style attributors so font/size are stored as style='...' not class=''
const FontStyle = Quill.import('attributors/style/font');
const SizeStyle = Quill.import('attributors/style/size');
Quill.register(FontStyle, true);
Quill.register(SizeStyle, true);

const FONT_FAMILIES = ['Arial', 'Georgia', 'Times New Roman', 'Courier New', 'Verdana', 'Comic Sans MS'];
const FONT_SIZES = [
  { label: '10pt', value: '10px' }, { label: '13pt', value: '13px' }, { label: '16pt', value: '16px' },
  { label: '18pt', value: '18px' }, { label: '24pt', value: '24px' }, { label: '32pt', value: '32px' }, { label: '48pt', value: '48px' },
];

function makeNote(folderId = null) {
  return { id: Date.now(), title: 'Untitled', content: '', strokes: [], updatedAt: new Date().toISOString(), folderId };
}
function mapNote(row) {
  return { id: row.id, title: row.title || 'Untitled', content: row.content || '', strokes: [], updatedAt: row.updated_at, folderId: row.folder_id || null };
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
function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatRecognizedText(raw) {
  const lines = raw.split(/\n+/).map(l => l.trimEnd()).filter(l => l.trim());
  if (!lines.length) return '';
  const bulletRe  = /^(\s*)[•\-*·]\s+(.*)$/;
  const orderedRe = /^\d+[.)]\s+/;
  const allBullet  = lines.every(l => bulletRe.test(l));
  const allOrdered = lines.every(l => orderedRe.test(l.trim()));
  if (allBullet) {
    const items = lines.map(l => { const m = l.match(bulletRe); return { indent: m[1].length, text: escHtml(m[2].trim()) }; });
    let html = '<ul>';
    let topOpen = false;
    let inSub = false;
    for (const item of items) {
      if (item.indent === 0) {
        if (inSub)   { html += '</ul>'; inSub = false; }
        if (topOpen) { html += '</li>'; }
        html += `<li>${item.text}`;
        topOpen = true;
      } else {
        if (!topOpen) {
          html += `<li>${item.text}</li>`;
        } else {
          if (!inSub) { html += '<ul style="list-style-type:circle">'; inSub = true; }
          html += `<li>${item.text}</li>`;
        }
      }
    }
    if (inSub)   html += '</ul>';
    if (topOpen) html += '</li>';
    html += '</ul>';
    return html;
  }
  if (allOrdered) {
    return '<ol>' + lines.map(l => `<li>${escHtml(l.trim().replace(orderedRe, ''))}</li>`).join('') + '</ol>';
  }
  return lines.map(l => {
    const leading = (l.match(/^( +)/) || ['', ''])[1].length;
    const indent  = Math.floor(leading / 2);
    const text    = escHtml(l.trim());
    return indent > 0
      ? `<div style="padding-left:${indent * 40}px">${text}</div>`
      : `<div>${text}</div>`;
  }).join('');
}

// ── Notebook Cover (Framer Motion) ─────────────────────────────────────────────

function NotebookCover({ onSignIn, onSignUp, onGuest, error, loading, opening }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const coverControls = useAnimation();
  const sceneControls = useAnimation();
  const rings = Array.from({ length: 22 }, (_, i) => i);

  useEffect(() => {
    if (!opening) return;
    (async () => {
      // Phase 1 — Lift: cover rises off the desk (0–500ms)
      await coverControls.start({
        z: 22,
        scale: 1.02,
        boxShadow: '0 22px 65px rgba(0,0,0,0.72), 0 10px 32px rgba(0,0,0,0.5)',
        transition: { duration: 0.5, ease: [0.25, 0.46, 0.45, 0.94] },
      });
      // Phase 2 — Swing cover + fade entire scene simultaneously (500–2200ms)
      // Cover swings; binding, pages, and background all fade out in lockstep
      coverControls.start({
        rotateY: -180,
        z: 0,
        scale: 1,
        boxShadow: '0 2px 8px rgba(0,0,0,0.15), 0 1px 3px rgba(0,0,0,0.1)',
        transition: { duration: 1.7, ease: [0.645, 0.045, 0.355, 1.000] },
      });
      await sceneControls.start({
        opacity: 0,
        transition: { duration: 1.7, ease: 'easeIn' },
      });
    })();
  }, [opening]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <motion.div className="notebook-scene" animate={sceneControls} initial={{ opacity: 1 }}>
      <div className="notebook-wrap">
        {/* Page stack — cream pages peeking past the cover's right edge */}
        <div className="nb-page nb-page-a" />
        <div className="nb-page nb-page-b" />
        <div className="nb-page nb-page-c" />

        {/* Fixed spine — the hinge point, never moves */}
        <div className="nb-spine">
          {rings.map(i => <div key={i} className="nb-ring" />)}
        </div>

        {/* Perspective container for 3D cover */}
        <div className="nb-perspective">
          <motion.div
            className="nb-cover-3d"
            animate={coverControls}
            initial={{
              rotateY: 0, scale: 1, z: 0, opacity: 1,
              boxShadow: '0 10px 40px rgba(0,0,0,0.6), 0 4px 14px rgba(0,0,0,0.38)',
            }}
            style={{ originX: 0, originY: '50%', transformStyle: 'preserve-3d' }}
          >
            {/* Back face — warm tan inside lining, visible after 90deg swing */}
            <div className="nb-cover-inside" />

            {/* Front face — warm brown leather cover */}
            <div className="nb-cover">
              <div className="nb-body">
                <div className="nb-bookmark" />
                <div className="nb-title-wrap">
                  <div className="nb-title-label">
                    <h1 className="nb-title">Notes</h1>
                  </div>
                  <p className="nb-subtitle">keep your thoughts.</p>
                </div>
                <div className="nb-form">
                  <input
                    className="nb-input" type="email" placeholder="Email"
                    value={email} onChange={e => setEmail(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && onSignIn(email, password)}
                    autoComplete="email"
                  />
                  <input
                    className="nb-input" type="password" placeholder="Password"
                    value={password} onChange={e => setPassword(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && onSignIn(email, password)}
                    autoComplete="current-password"
                  />
                  {error && <div className="nb-error">{error}</div>}
                  <div className="nb-btn-row">
                    <button className="nb-btn-primary" onClick={() => onSignIn(email, password)} disabled={loading}>
                      {loading ? 'Please wait…' : 'Sign In'}
                    </button>
                    <button className="nb-btn-secondary" onClick={() => onSignUp(email, password)} disabled={loading}>
                      Sign Up
                    </button>
                  </div>
                  <div className="nb-divider" />
                  <button className="nb-btn-ghost" onClick={onGuest} disabled={loading}>
                    Continue as Guest
                  </button>
                </div>
              </div>
            </div>
          </motion.div>
        </div>
      </div>
    </motion.div>
  );
}

// ── App ─────────────────────────────────────────────────────────────────────────

export default function App() {
  // Auth
  const [session, setSession]         = useState(null);
  const [isGuest, setIsGuest]         = useState(false);
  const [showApp, setShowApp]         = useState(false);
  const [openingBook, setOpeningBook] = useState(false);
  const [authError, setAuthError]     = useState(null);
  const [authLoading, setAuthLoading] = useState(false);

  // Notes & folders
  const [notes, setNotes]                         = useState([makeNote()]);
  const [activeId, setActiveId]                   = useState(null);
  const [folders, setFolders]                     = useState([]);
  const [expandedFolderIds, setExpandedFolderIds] = useState(new Set());
  const [activeFolderId, setActiveFolderId]       = useState(null);
  const [renamingFolderId, setRenamingFolderId]   = useState(null);

  // UI
  const [sidebarOpen, setSidebarOpen]   = useState(false);
  const [drawMode, setDrawMode]         = useState(false);
  const [eraserActive, setEraserActive] = useState(false);
  const [converting, setConverting]     = useState(false);
  const [convertError, setConvertError] = useState(null);
  const [saveStatus, setSaveStatus]     = useState('idle');
  const [formats, setFormats]           = useState({});
  const [color, setColor]               = useState('#000000');

  // Refs
  const quillRef         = useRef(null);   // ReactQuill component ref
  const editorScrollRef  = useRef(null);
  const drawingCanvasRef = useRef(null);
  const savedQuillRange  = useRef(null);   // last Quill selection before toolbar focus
  const notesRef         = useRef(notes);
  const sessionRef       = useRef(session);
  const autosaveTimerRef = useRef(null);
  const prevEidRef       = useRef(null);

  useEffect(() => { notesRef.current = notes; }, [notes]);
  useEffect(() => { sessionRef.current = session; }, [session]);

  // Derived
  const eid        = (activeId && notes.find(n => n.id === activeId)) ? activeId : notes[0]?.id;
  const activeNote = notes.find(n => n.id === eid) || notes[0];

  // ── Auth init ──────────────────────────────────────────────────────────────

  useEffect(() => {
    // Existing session on page load → show app immediately, no animation
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) { setSession(session); setShowApp(true); }
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, newSession) => {
      if (!newSession) {
        // Sign-out: reset everything and show cover
        setSession(null); setIsGuest(false); setShowApp(false); setOpeningBook(false);
      } else if (event === 'TOKEN_REFRESHED') {
        setSession(newSession);
      }
    });
    return () => {
      subscription.unsubscribe();
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    };
  }, []);

  // Load from Supabase on login; reset on logout
  useEffect(() => {
    if (session) loadAll();
    else if (!isGuest) { setNotes([makeNote()]); setActiveId(null); setFolders([]); }
  }, [session]); // eslint-disable-line react-hooks/exhaustive-deps

  // Guest: persist notes to localStorage
  useEffect(() => { if (isGuest) localStorage.setItem('notes-v2', JSON.stringify(notes)); }, [notes, isGuest]);
  useEffect(() => { if (isGuest && eid) localStorage.setItem('notes-active', JSON.stringify(eid)); }, [eid, isGuest]);

  // Autosave on note switch + sync editor content
  useEffect(() => {
    if (prevEidRef.current && prevEidRef.current !== eid && sessionRef.current) {
      if (autosaveTimerRef.current) { clearTimeout(autosaveTimerRef.current); autosaveTimerRef.current = null; }
      doAutosave(prevEidRef.current);
    }
    prevEidRef.current = eid;
    const quillInst = quillRef.current?.getEditor();
    if (quillInst) {
      quillInst.clipboard.dangerouslyPasteHTML(activeNote?.content || '');
      quillInst.setSelection(0, 0, 'silent');
    }
  }, [eid]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!convertError) return;
    const t = setTimeout(() => setConvertError(null), 3500);
    return () => clearTimeout(t);
  }, [convertError]);

  // ── Data loading ───────────────────────────────────────────────────────────

  async function loadAll() {
    const [fRes, nRes] = await Promise.all([
      supabase.from('folders').select('*').order('created_at'),
      supabase.from('notes').select('*').order('updated_at', { ascending: false }),
    ]);
    if (!fRes.error) setFolders(fRes.data || []);
    const notesData = nRes.data || [];
    if (!notesData.length) {
      const { data: row } = await supabase.from('notes')
        .insert({ title: 'Untitled', content: '', user_id: session.user.id, folder_id: null })
        .select().single();
      if (row) { const n = mapNote(row); setNotes([n]); setActiveId(n.id); }
    } else {
      const mapped = notesData.map(mapNote);
      setNotes(mapped); setActiveId(mapped[0].id);
    }
  }

  // ── Autosave ───────────────────────────────────────────────────────────────

  const doAutosave = useCallback(async (noteId) => {
    const note = notesRef.current.find(n => n.id === noteId);
    const sess = sessionRef.current;
    if (!note || !sess) return;
    setSaveStatus('saving');
    const now = new Date().toISOString();
    const isNew = typeof note.id === 'number';
    try {
      if (isNew) {
        const { data, error } = await supabase.from('notes')
          .insert({ title: note.title || 'Untitled', content: note.content || '', user_id: sess.user.id, folder_id: note.folderId || null })
          .select().single();
        if (error) throw error;
        const saved = mapNote(data);
        setNotes(p => p.map(n => n.id === noteId ? { ...saved, strokes: n.strokes } : n));
        setActiveId(cur => cur === noteId ? saved.id : cur);
      } else {
        const { error } = await supabase.from('notes')
          .update({ title: note.title, content: note.content, updated_at: now })
          .eq('id', note.id);
        if (error) throw error;
        setNotes(p => p.map(n => n.id === noteId ? { ...n, updatedAt: now } : n));
      }
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus(s => s === 'saved' ? 'idle' : s), 2000);
    } catch { setSaveStatus('error'); }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function scheduleAutosave(noteId) {
    if (!sessionRef.current) return;
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = setTimeout(() => doAutosave(noteId), 2000);
  }

  // ── Auth handlers ──────────────────────────────────────────────────────────

  async function handleSignIn(email, password) {
    setAuthLoading(true); setAuthError(null);
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) { setAuthError(error.message); setAuthLoading(false); return; }
    setAuthLoading(false);
    setSession(data.session);
    setOpeningBook(true);
    setTimeout(() => { setShowApp(true); }, 1900);    // app fades in 300ms before scene finishes
    setTimeout(() => { setOpeningBook(false); }, 2300); // unmount cover after animation ends
  }

  async function handleSignUp(email, password) {
    setAuthLoading(true); setAuthError(null);
    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error) { setAuthError(error.message); setAuthLoading(false); return; }
    if (data?.session) {
      setAuthLoading(false);
      setSession(data.session);
      setOpeningBook(true);
      setTimeout(() => { setShowApp(true); }, 1900);
      setTimeout(() => { setOpeningBook(false); }, 2300);
    } else {
      setAuthError('Check your email to confirm your account.');
      setAuthLoading(false);
    }
  }

  async function handleSignOut() {
    await supabase.auth.signOut();
    const q = quillRef.current?.getEditor();
    if (q) q.setText('', 'api');
    setDrawMode(false); setEraserActive(false);
    setFolders([]); setActiveFolderId(null); setExpandedFolderIds(new Set());
  }

  function handleGuestMode() {
    let guestNotes, guestActiveId;
    try {
      const saved = JSON.parse(localStorage.getItem('notes-v2'));
      if (Array.isArray(saved) && saved.length) {
        guestNotes = saved.map(n => ({ ...n, strokes: n.strokes || [] }));
        const stored = JSON.parse(localStorage.getItem('notes-active'));
        guestActiveId = (stored && saved.find(n => n.id === stored)) ? stored : saved[0].id;
      }
    } catch {}
    if (!guestNotes) { const n = makeNote(); guestNotes = [n]; guestActiveId = n.id; }
    setNotes(guestNotes); setActiveId(guestActiveId); setIsGuest(true);
    setOpeningBook(true);
    setTimeout(() => { setShowApp(true); }, 1900);
    setTimeout(() => { setOpeningBook(false); }, 2300);
  }

  function handleGuestSignIn() { setIsGuest(false); setShowApp(false); }

  // ── Folder CRUD ────────────────────────────────────────────────────────────

  async function createFolder() {
    if (!session) return;
    const { data, error } = await supabase.from('folders')
      .insert({ name: 'New Folder', user_id: session.user.id })
      .select().single();
    if (error) { console.error(error); return; }
    setFolders(p => [...p, data]);
    setExpandedFolderIds(s => new Set([...s, data.id]));
    setActiveFolderId(data.id);
    setRenamingFolderId(data.id);
  }

  function toggleFolder(id) {
    setExpandedFolderIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function renameFolder(id, name) {
    const trimmed = (name || '').trim() || 'New Folder';
    await supabase.from('folders').update({ name: trimmed }).eq('id', id);
    setFolders(p => p.map(f => f.id === id ? { ...f, name: trimmed } : f));
    setRenamingFolderId(null);
  }

  async function deleteFolder(id, name) {
    if (!window.confirm(`Delete folder "${name}" and all its notes? This cannot be undone.`)) return;
    await supabase.from('notes').delete().eq('folder_id', id);
    await supabase.from('folders').delete().eq('id', id);
    const currentNotes = notesRef.current;
    const remaining = currentNotes.filter(n => n.folderId !== id);
    if (!remaining.length) {
      const n = makeNote(); setNotes([n]); setActiveId(n.id);
    } else {
      setNotes(remaining);
      if (currentNotes.find(n => n.id === eid && n.folderId === id)) setActiveId(remaining[0].id);
    }
    setFolders(p => p.filter(f => f.id !== id));
    if (activeFolderId === id) setActiveFolderId(null);
    setExpandedFolderIds(prev => { const next = new Set(prev); next.delete(id); return next; });
  }

  // ── Note CRUD ──────────────────────────────────────────────────────────────

  const newNote = useCallback(() => {
    const n = makeNote(activeFolderId);
    setNotes(p => [n, ...p]); setActiveId(n.id); setSidebarOpen(false);
  }, [activeFolderId]);

  const openNote = useCallback((id) => { setActiveId(id); setSidebarOpen(false); }, []);

  const deleteNote = useCallback(async (id, e) => {
    e.stopPropagation();
    if (session && typeof id !== 'number') await supabase.from('notes').delete().eq('id', id);
    setNotes(prev => {
      const rest = prev.filter(n => n.id !== id);
      if (!rest.length) { const n = makeNote(); setActiveId(n.id); return [n]; }
      if (id === eid) setActiveId(rest[0].id);
      return rest;
    });
  }, [eid, session]);

  const setTitle = useCallback((title) => {
    setNotes(p => p.map(n => n.id === eid ? { ...n, title, updatedAt: new Date().toISOString() } : n));
    scheduleAutosave(eid);
  }, [eid]); // eslint-disable-line react-hooks/exhaustive-deps

  const onEditorInput = useCallback(() => {
    const quill = quillRef.current?.getEditor();
    if (!quill) return;
    const content = quill.root.innerHTML;
    setNotes(p => p.map(n => n.id === eid ? { ...n, content, updatedAt: new Date().toISOString() } : n));
    scheduleAutosave(eid);
  }, [eid]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Editor / format handlers ───────────────────────────────────────────────

  // Save Quill selection before a toolbar control steals focus
  const saveQuillRange = useCallback(() => {
    const quill = quillRef.current?.getEditor();
    if (quill) savedQuillRange.current = quill.getSelection();
  }, []);

  // Restore saved Quill selection so format commands hit the right text
  const restoreQuillRange = useCallback(() => {
    const quill = quillRef.current?.getEditor();
    if (!quill) return;
    quill.focus();
    if (savedQuillRange.current) {
      quill.setSelection(savedQuillRange.current.index, savedQuillRange.current.length, 'silent');
    }
  }, []);

  const refreshFormats = useCallback(() => {
    const quill = quillRef.current?.getEditor();
    if (!quill) { setFormats({}); return; }
    const f = quill.getFormat();
    setFormats({
      bold:                !!f.bold,
      italic:              !!f.italic,
      underline:           !!f.underline,
      justifyLeft:         !f.align,
      justifyCenter:       f.align === 'center',
      justifyRight:        f.align === 'right',
      insertUnorderedList: f.list === 'bullet',
      insertOrderedList:   f.list === 'ordered',
    });
  }, []);

  const execBtn = useCallback((e, cmd) => {
    e.preventDefault();
    restoreQuillRange();
    const quill = quillRef.current?.getEditor();
    if (!quill) return;
    const f = quill.getFormat();
    switch (cmd) {
      case 'bold':                quill.format('bold',      !f.bold);                              break;
      case 'italic':              quill.format('italic',    !f.italic);                            break;
      case 'underline':           quill.format('underline', !f.underline);                         break;
      case 'justifyLeft':         quill.format('align',     false);                                break;
      case 'justifyCenter':       quill.format('align',     'center');                             break;
      case 'justifyRight':        quill.format('align',     'right');                              break;
      case 'insertUnorderedList': quill.format('list', f.list === 'bullet'  ? false : 'bullet');   break;
      case 'insertOrderedList':   quill.format('list', f.list === 'ordered' ? false : 'ordered');  break;
      case 'indent':              quill.format('indent', '+1');                                    break;
      case 'outdent':             quill.format('indent', '-1');                                    break;
      default: break;
    }
    refreshFormats();
  }, [refreshFormats, restoreQuillRange]);

  const applyFont = useCallback((e) => {
    restoreQuillRange();
    quillRef.current?.getEditor()?.format('font', e.target.value);
  }, [restoreQuillRange]);

  const applySize = useCallback((e) => {
    restoreQuillRange();
    quillRef.current?.getEditor()?.format('size', e.target.value);
  }, [restoreQuillRange]);

  const applyColor = useCallback((e) => {
    const c = e.target.value;
    setColor(c);
    restoreQuillRange();
    quillRef.current?.getEditor()?.format('color', c);
  }, [restoreQuillRange]);

  const updateStrokes = useCallback((newStrokes) => {
    setNotes(p => p.map(n => n.id === eid ? { ...n, strokes: newStrokes, updatedAt: new Date().toISOString() } : n));
  }, [eid]);

  const convertDrawingToText = useCallback(async () => {
    if (converting) return;
    const strokes = activeNote?.strokes || [];
    const penPts  = strokes.filter(s => !s.erase).flatMap(s => s.pts);
    if (!penPts.length) { setConvertError('Nothing to convert — please write something first.'); return; }
    setConverting(true); setConvertError(null);
    try {
      const canvas = drawingCanvasRef.current?.getCanvas();
      if (!canvas) throw new Error('no-canvas');
      const dpr = window.devicePixelRatio || 1, pad = 24;
      const minX = Math.max(0, Math.min(...penPts.map(p => p.x)) - pad);
      const maxX = Math.min(canvas.offsetWidth, Math.max(...penPts.map(p => p.x)) + pad);
      const minY = Math.max(0, Math.min(...penPts.map(p => p.y)) - pad);
      const maxY = Math.min(canvas.offsetHeight, Math.max(...penPts.map(p => p.y)) + pad);
      const cropW = Math.max(1, maxX - minX), cropH = Math.max(1, maxY - minY);
      const tmp = document.createElement('canvas');
      tmp.width = Math.round(cropW * dpr); tmp.height = Math.round(cropH * dpr);
      const tmpCtx = tmp.getContext('2d');
      tmpCtx.fillStyle = '#ffffff'; tmpCtx.fillRect(0, 0, tmp.width, tmp.height);
      tmpCtx.drawImage(canvas, Math.round(minX * dpr), Math.round(minY * dpr), Math.round(cropW * dpr), Math.round(cropH * dpr), 0, 0, tmp.width, tmp.height);
      const base64Data = tmp.toDataURL('image/png').split(',')[1];
      let response;
      try {
        response = await fetch('/api/anthropic/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'anthropic-dangerous-direct-browser-access': 'true' },
          body: JSON.stringify({
            model: 'claude-sonnet-4-6', max_tokens: 1024,
            system: 'You are a handwriting recognition assistant. The user will send you an image of handwritten notes on a canvas. Your job is to transcribe the handwriting as accurately as possible into plain text. Preserve the structure of the writing. For bullet points: use "- " (dash + space) for top-level bullets and "  - " (two spaces + dash + space) for visually indented sub-bullets that appear further to the right beneath a parent bullet. If there are numbered lists transcribe them as numbered lists. Keep multiple lines as separate lines and preserve other indentation. Return only the transcribed text with no explanation or commentary.',
            messages: [{ role: 'user', content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64Data } },
              { type: 'text', text: 'Transcribe the handwriting in this image.' },
            ]}],
          }),
        });
      } catch (fetchErr) { console.error('Fetch error:', fetchErr); throw fetchErr; }
      if (!response.ok) {
        let eb; try { eb = await response.json(); } catch { eb = await response.text(); }
        console.error('API error:', response.status, eb); throw new Error(`HTTP ${response.status}`);
      }
      const data = await response.json();
      const rawText = data.content?.[0]?.text;
      if (!rawText?.trim()) throw new Error('empty');
      const html = formatRecognizedText(rawText);
      setDrawMode(false); setEraserActive(false);
      await new Promise(r => requestAnimationFrame(r));
      const quill = quillRef.current?.getEditor();
      const scrollEl = editorScrollRef.current;
      if (quill) {
        const len = quill.getLength();
        if (len > 1) quill.insertText(len - 1, '\n', 'user');
        quill.clipboard.dangerouslyPasteHTML(quill.getLength() - 1, html);
        onEditorInput();
        if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
      }
      updateStrokes([]); drawingCanvasRef.current?.clearCanvas();
    } catch (err) {
      console.warn('Convert:', err);
      setConvertError('Could not convert handwriting — please try again.');
    } finally { setConverting(false); }
  }, [activeNote, converting, updateStrokes, onEditorInput]); // eslint-disable-line react-hooks/exhaustive-deps

  const hasStrokes = !!(activeNote?.strokes?.filter(s => !s.erase).length);

  // ── Sidebar note renderer ──────────────────────────────────────────────────

  function renderSbNote(n, indented = false) {
    return (
      <div
        key={n.id}
        className={`sb-note${n.id === eid ? ' active' : ''}${indented ? ' sb-note-indented' : ''}`}
        onPointerDown={() => openNote(n.id)}
      >
        <div className="sb-note-title"><span className="sb-note-icon"><DocumentIcon /></span>{n.title || 'Untitled'}</div>
        <div className="sb-note-preview">{stripHtml(n.content).slice(0, 55) || 'No content'}</div>
        <div className="sb-note-foot">
          <span className="sb-date">{formatDate(n.updatedAt)}</span>
          <button className="sb-del" onPointerDown={e => deleteNote(n.id, e)} title="Delete">×</button>
        </div>
      </div>
    );
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="app-root">
      {/* Main app — only shown after animation completes */}
      {showApp && (session || isGuest) && (
        <motion.div
          className="app"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.4, ease: 'easeOut' }}
        >
          {session && (
            <>
              <div className={`sidebar${sidebarOpen ? ' open' : ''}`}>
                <div className="sb-head">
                  <span className="sb-heading">Notes</span>
                  <div className="sb-head-btns">
                    <button className="sb-icon-btn" onPointerDown={createFolder} title="New folder"><FolderPlusIcon /></button>
                    <button className="sb-new" onPointerDown={newNote} title="New note">＋</button>
                  </div>
                </div>
                <div className="sb-list">
                  {notes.filter(n => !n.folderId).map(n => renderSbNote(n))}
                  {folders.map(folder => (
                    <div key={folder.id} className="sb-folder">
                      <div
                        className={`sb-folder-head${activeFolderId === folder.id ? ' active' : ''}`}
                        onPointerDown={() => { setActiveFolderId(folder.id); toggleFolder(folder.id); }}
                      >
                        <span className={`sb-folder-arrow${expandedFolderIds.has(folder.id) ? ' open' : ''}`}>▶</span>
                        <span className="sb-folder-icon"><FolderIcon /></span>
                        {renamingFolderId === folder.id ? (
                          <input
                            className="sb-folder-rename-input"
                            defaultValue={folder.name} autoFocus
                            onClick={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()}
                            onBlur={e => renameFolder(folder.id, e.target.value)}
                            onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') setRenamingFolderId(null); }}
                          />
                        ) : (
                          <span className="sb-folder-name" onDoubleClick={e => { e.stopPropagation(); setRenamingFolderId(folder.id); }}>
                            {folder.name}
                          </span>
                        )}
                        <button className="sb-del" onPointerDown={e => { e.stopPropagation(); deleteFolder(folder.id, folder.name); }} title="Delete folder">×</button>
                      </div>
                      {expandedFolderIds.has(folder.id) && (
                        <div className="sb-folder-notes">
                          {notes.filter(n => n.folderId === folder.id).map(n => renderSbNote(n, true))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
              {sidebarOpen && <div className="sb-overlay" onPointerDown={() => setSidebarOpen(false)} />}
            </>
          )}

          <div className="main">
            <div className="topbar">
              {session && <button className="tbtn" onPointerDown={() => setSidebarOpen(s => !s)} title="All notes"><MenuIcon /></button>}
              <input className="title-input" value={activeNote?.title || ''} onChange={e => setTitle(e.target.value)} placeholder="Untitled" />
              {session && saveStatus !== 'idle' && (
                <span className={`save-status save-status-${saveStatus}`}>
                  {saveStatus === 'saving' ? 'Saving…' : saveStatus === 'saved' ? 'Saved ✓' : 'Save failed'}
                </span>
              )}
              {session ? (
                <div className="user-area">
                  <span className="user-email">{session.user.email}</span>
                  <button className="tbtn signout-btn" onPointerDown={handleSignOut}>Sign Out</button>
                </div>
              ) : (
                <button className="tbtn signout-btn" onPointerDown={handleGuestSignIn}>Sign In</button>
              )}
            </div>

            <div className="toolbar" role="toolbar">
              <div className="toolbar-group">
                <select className="tb-select font-select" defaultValue="Arial" onFocus={saveQuillRange} onChange={applyFont}>
                  {FONT_FAMILIES.map(f => <option key={f} value={f}>{f}</option>)}
                </select>
                <select className="tb-select size-select" defaultValue="16px" onFocus={saveQuillRange} onChange={applySize}>
                  {FONT_SIZES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
              </div>
              <span className="tb-div" />
              <div className="toolbar-group">
                <button className={tbtn(formats.bold)}      onPointerDown={e => execBtn(e,'bold')}      title="Bold"><b>B</b></button>
                <button className={tbtn(formats.italic)}    onPointerDown={e => execBtn(e,'italic')}    title="Italic"><i>I</i></button>
                <button className={tbtn(formats.underline)} onPointerDown={e => execBtn(e,'underline')} title="Underline"><u>U</u></button>
              </div>
              <span className="tb-div" />
              <div className="toolbar-group">
                <label className="tbtn color-btn" title="Text color">
                  <span className="color-a" style={{ '--c': color }}>A</span>
                  <input type="color" value={color} onFocus={saveQuillRange} onChange={applyColor} className="sr-only" />
                </label>
              </div>
              <span className="tb-div" />
              <div className="toolbar-group">
                <button className={tbtn(formats.justifyLeft)}   onPointerDown={e => execBtn(e,'justifyLeft')}   title="Left"><AlignLeftIcon /></button>
                <button className={tbtn(formats.justifyCenter)} onPointerDown={e => execBtn(e,'justifyCenter')} title="Center"><AlignCenterIcon /></button>
                <button className={tbtn(formats.justifyRight)}  onPointerDown={e => execBtn(e,'justifyRight')}  title="Right"><AlignRightIcon /></button>
              </div>
              <span className="tb-div" />
              <div className="toolbar-group">
                <button className={tbtn(formats.insertUnorderedList)} onPointerDown={e => execBtn(e,'insertUnorderedList')} title="Bullets"><BulletListIcon /></button>
                <button className={tbtn(formats.insertOrderedList)}   onPointerDown={e => execBtn(e,'insertOrderedList')}   title="Numbers"><span className="list-num">1.</span></button>
              </div>
              <span className="tb-div" />
              <div className="toolbar-group">
                <button className="tbtn" onPointerDown={e => execBtn(e,'outdent')} title="Decrease indent"><OutdentIcon /></button>
                <button className="tbtn" onPointerDown={e => execBtn(e,'indent')}  title="Increase indent"><IndentIcon /></button>
              </div>
              <span className="tb-div" />
              <div className="toolbar-group">
                <button
                  className={tbtn(drawMode)}
                  onPointerDown={() => { setDrawMode(m => { if (m) { drawingCanvasRef.current?.clearCanvas(); updateStrokes([]); } return !m; }); setEraserActive(false); }}
                  title={drawMode ? 'Switch to typing' : 'Switch to drawing'}
                >
                  {drawMode ? <KeyboardIcon /> : <PenIcon />}
                </button>
                {drawMode && (
                  <button className={tbtn(eraserActive)} onPointerDown={() => setEraserActive(e => !e)} title={eraserActive ? 'Switch to pen' : 'Eraser'}>
                    <EraserIcon />
                  </button>
                )}
                {drawMode && (
                  <button className="tbtn" onPointerDown={() => convertDrawingToText()} title="Convert handwriting to text"
                    disabled={converting || !hasStrokes} style={{ opacity: (!hasStrokes && !converting) ? 0.4 : 1 }}>
                    {converting ? <SpinnerIcon /> : <WandIcon />}
                  </button>
                )}
              </div>
            </div>

            {isGuest && (
              <div className="guest-banner">
                Guest mode — notes are not saved to the cloud. Use <strong>Sign In</strong> above to keep your notes.
              </div>
            )}

            {drawMode && <div className="scroll-zone-hint" />}

            <div className="editor-scroll" ref={editorScrollRef}>
              <div className="editor-layer">
                <ReactQuill
                  ref={quillRef}
                  theme="snow"
                  modules={{ toolbar: false }}
                  className={`quill-editor${drawMode ? ' draw-mode' : ''}`}
                  placeholder="Start typing your note…"
                  onChange={(_, __, source) => { if (source === 'user') onEditorInput(); }}
                  onChangeSelection={(range) => {
                    if (range) savedQuillRange.current = range;
                    refreshFormats();
                  }}
                />
                <DrawingCanvas
                  ref={drawingCanvasRef} noteId={eid}
                  initialStrokes={activeNote?.strokes || []}
                  onStrokesChange={updateStrokes}
                  drawMode={drawMode} eraser={eraserActive}
                  scrollElRef={editorScrollRef}
                />
              </div>
            </div>
            {convertError && <div className="convert-error">{convertError}</div>}
          </div>
        </motion.div>
      )}

      {/* Notebook cover — kept in DOM until 100ms after animation so crossfade can overlap */}
      {(!showApp || openingBook) && (
        <NotebookCover
          onSignIn={handleSignIn} onSignUp={handleSignUp}
          onGuest={handleGuestMode} error={authError} loading={authLoading}
          opening={openingBook}
        />
      )}
    </div>
  );
}

// ── Drawing Canvas ──────────────────────────────────────────────────────────────

const SCROLL_ZONE_PX = 60;
const ERASER_RADIUS  = 20;

const DrawingCanvas = React.forwardRef(function DrawingCanvas(
  { noteId, initialStrokes, onStrokesChange, drawMode, eraser, scrollElRef }, ref
) {
  const canvasRef       = useRef(null);
  const ctxRef          = useRef(null);
  const eraserCursorRef = useRef(null);
  const strokesRef      = useRef([...(initialStrokes || [])]);
  const liveRef         = useRef(null);
  const isDrawingRef    = useRef(false);
  const isScrollRef     = useRef(false);
  const lastScrollYRef  = useRef(0);

  useImperativeHandle(ref, () => ({
    getCanvas: () => canvasRef.current,
    clearCanvas: () => { strokesRef.current = []; redraw(); },
  }));

  useEffect(() => { strokesRef.current = [...(initialStrokes || [])]; redraw(); }, [noteId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!eraser && eraserCursorRef.current) eraserCursorRef.current.style.display = 'none'; redraw(); }, [eraser]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    function resize() {
      const parent = canvas.parentElement; if (!parent) return;
      const dpr = window.devicePixelRatio || 1, w = canvas.offsetWidth, h = canvas.offsetHeight;
      if (!w || !h) return;
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr); ctxRef.current = ctx; redraw();
    }
    resize();
    const ro = new ResizeObserver(resize); ro.observe(canvas.parentElement);
    return () => ro.disconnect();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function redraw() {
    const ctx = ctxRef.current, canvas = canvasRef.current; if (!ctx || !canvas) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
    for (const s of strokesRef.current) s.erase ? applyErase(ctx, s.pts) : paintStroke(ctx, s.pts);
    if (liveRef.current) liveRef.current.erasing ? applyErase(ctx, liveRef.current.pts) : paintStroke(ctx, liveRef.current.pts);
  }

  function paintStroke(ctx, pts) {
    if (!pts || !pts.length) return;
    ctx.save(); ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = '#1a1a2e'; ctx.lineWidth = 2.5; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    if (pts.length === 1) {
      ctx.beginPath(); ctx.arc(pts[0].x, pts[0].y, 1.25, 0, Math.PI * 2);
      ctx.fillStyle = '#1a1a2e'; ctx.fill(); ctx.restore(); return;
    }
    ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i].x + pts[i+1].x) / 2, my = (pts[i].y + pts[i+1].y) / 2;
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
    }
    ctx.lineTo(pts[pts.length-1].x, pts[pts.length-1].y); ctx.stroke(); ctx.restore();
  }

  function applyErase(ctx, pts) {
    if (!pts || !pts.length) return;
    ctx.save(); ctx.globalCompositeOperation = 'destination-out';
    ctx.lineWidth = ERASER_RADIUS * 2; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(0,0,0,1)'; ctx.fillStyle = 'rgba(0,0,0,1)';
    if (pts.length === 1) { ctx.beginPath(); ctx.arc(pts[0].x, pts[0].y, ERASER_RADIUS, 0, Math.PI * 2); ctx.fill(); }
    else { ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y); for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y); ctx.stroke(); }
    ctx.restore();
  }

  function getPoint(e) {
    const scrollEl = scrollElRef.current; if (!scrollEl) return { x: 0, y: 0, t: Date.now() };
    const rect = scrollEl.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top + scrollEl.scrollTop, t: Date.now() };
  }

  function updateEraserCursor(e) {
    if (!eraserCursorRef.current) return;
    const pt = getPoint(e);
    eraserCursorRef.current.style.left = pt.x + 'px'; eraserCursorRef.current.style.top = pt.y + 'px';
    eraserCursorRef.current.style.display = 'block';
  }

  function onPointerDown(e) {
    if (!drawMode) return;
    const scrollEl = scrollElRef.current; if (!scrollEl) return;
    const rect = scrollEl.getBoundingClientRect();
    if (e.clientX >= rect.right - SCROLL_ZONE_PX) {
      if (eraserCursorRef.current) eraserCursorRef.current.style.display = 'none';
      isScrollRef.current = true; lastScrollYRef.current = e.clientY;
      canvasRef.current.setPointerCapture(e.pointerId); return;
    }
    e.preventDefault(); canvasRef.current.setPointerCapture(e.pointerId);
    isDrawingRef.current = true;
    if (eraser) updateEraserCursor(e);
    liveRef.current = { pts: [getPoint(e)], erasing: eraser }; redraw();
  }

  function onPointerMove(e) {
    if (isScrollRef.current) {
      const scrollEl = scrollElRef.current;
      if (scrollEl) scrollEl.scrollTop += lastScrollYRef.current - e.clientY;
      lastScrollYRef.current = e.clientY; return;
    }
    if (eraser && drawMode) { updateEraserCursor(e); if (!isDrawingRef.current) return; }
    if (!isDrawingRef.current || !liveRef.current) return;
    e.preventDefault();
    liveRef.current = { ...liveRef.current, pts: [...liveRef.current.pts, getPoint(e)] }; redraw();
  }

  function onPointerLeave() { if (eraserCursorRef.current) eraserCursorRef.current.style.display = 'none'; }

  function onPointerUp() {
    if (isScrollRef.current) { isScrollRef.current = false; return; }
    if (!isDrawingRef.current) return;
    isDrawingRef.current = false;
    if (liveRef.current && liveRef.current.pts.length > 0) {
      const newStroke = liveRef.current.erasing ? { pts: liveRef.current.pts, erase: true } : { pts: liveRef.current.pts };
      strokesRef.current = [...strokesRef.current, newStroke]; onStrokesChange([...strokesRef.current]);
    }
    liveRef.current = null; redraw();
  }

  const cursor = !drawMode ? 'default' : eraser ? 'none' : 'crosshair';

  return (
    <>
      <canvas ref={canvasRef} className={`draw-canvas${drawMode ? ' active' : ''}`} style={{ cursor }}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove}
        onPointerUp={onPointerUp} onPointerCancel={onPointerUp} onPointerLeave={onPointerLeave}
      />
      <div ref={eraserCursorRef} className="eraser-cursor" />
    </>
  );
});

// ── Icons ───────────────────────────────────────────────────────────────────────

function MenuIcon() {
  return <svg width="20" height="16" viewBox="0 0 20 16" fill="currentColor" aria-hidden="true">
    <rect x="0" y="0"    width="20" height="2.5" rx="1.25"/><rect x="0" y="6.75" width="20" height="2.5" rx="1.25"/>
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
    <rect x="3" y="2" width="12" height="8" rx="1.5" opacity="0.85"/><rect x="0" y="11.5" width="18" height="2" rx="1"/>
  </svg>;
}
function WandIcon() {
  return <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
    <line x1="2" y1="16" x2="10" y2="8" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
    <path d="M12 1 L12.9 3.1 L15 4 L12.9 4.9 L12 7 L11.1 4.9 L9 4 L11.1 3.1 Z" fill="currentColor"/>
    <path d="M6 1.5 L6.5 2.9 L7.9 3.4 L6.5 3.9 L6 5.3 L5.5 3.9 L4.1 3.4 L5.5 2.9 Z" fill="currentColor" opacity="0.6"/>
  </svg>;
}
function SpinnerIcon() {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" className="spin">
    <circle cx="8" cy="8" r="6" opacity="0.2"/><path d="M8 2 A6 6 0 0 1 14 8"/>
  </svg>;
}
function AlignLeftIcon() {
  return <svg width="18" height="14" viewBox="0 0 18 14" fill="currentColor" aria-hidden="true">
    <rect x="0" y="0" width="18" height="2" rx="1"/><rect x="0" y="4"  width="13" height="2" rx="1"/>
    <rect x="0" y="8" width="16" height="2" rx="1"/><rect x="0" y="12" width="10" height="2" rx="1"/>
  </svg>;
}
function AlignCenterIcon() {
  return <svg width="18" height="14" viewBox="0 0 18 14" fill="currentColor" aria-hidden="true">
    <rect x="0"   y="0" width="18" height="2" rx="1"/><rect x="2.5" y="4"  width="13" height="2" rx="1"/>
    <rect x="1"   y="8" width="16" height="2" rx="1"/><rect x="4"   y="12" width="10" height="2" rx="1"/>
  </svg>;
}
function AlignRightIcon() {
  return <svg width="18" height="14" viewBox="0 0 18 14" fill="currentColor" aria-hidden="true">
    <rect x="0" y="0" width="18" height="2" rx="1"/><rect x="5" y="4"  width="13" height="2" rx="1"/>
    <rect x="2" y="8" width="16" height="2" rx="1"/><rect x="8" y="12" width="10" height="2" rx="1"/>
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
    <rect x="7" y="0" width="11" height="2" rx="1"/><rect x="7" y="6"  width="11" height="2" rx="1"/>
    <rect x="7" y="12" width="11" height="2" rx="1"/><path d="M0 3L5 7L0 11Z"/>
  </svg>;
}
function OutdentIcon() {
  return <svg width="18" height="14" viewBox="0 0 18 14" fill="currentColor" aria-hidden="true">
    <rect x="7" y="0" width="11" height="2" rx="1"/><rect x="7" y="6"  width="11" height="2" rx="1"/>
    <rect x="7" y="12" width="11" height="2" rx="1"/><path d="M5 3L0 7L5 11Z"/>
  </svg>;
}
function FolderIcon() {
  return <svg width="15" height="13" viewBox="0 0 15 13" fill="currentColor" aria-hidden="true">
    <path d="M0 2.5A1.5 1.5 0 0 1 1.5 1H5l1.5 2H13.5A1.5 1.5 0 0 1 15 4.5v7A1.5 1.5 0 0 1 13.5 13h-12A1.5 1.5 0 0 1 0 11.5V2.5z" opacity="0.85"/>
  </svg>;
}
function FolderPlusIcon() {
  return <svg width="16" height="14" viewBox="0 0 16 14" fill="currentColor" aria-hidden="true">
    <path d="M0 2.5A1.5 1.5 0 0 1 1.5 1H5l1.5 2H14.5A1.5 1.5 0 0 1 16 4.5v8A1.5 1.5 0 0 1 14.5 14h-13A1.5 1.5 0 0 1 0 12.5V2.5z" opacity="0.85"/>
    <line x1="8" y1="6.5" x2="8" y2="11.5" stroke="white" strokeWidth="1.5" strokeLinecap="round"/>
    <line x1="5.5" y1="9" x2="10.5" y2="9" stroke="white" strokeWidth="1.5" strokeLinecap="round"/>
  </svg>;
}
function DocumentIcon() {
  return <svg width="11" height="13" viewBox="0 0 11 13" fill="currentColor" aria-hidden="true">
    <path d="M1 0h6.5L11 3.5V12a1 1 0 0 1-1 1H1a1 1 0 0 1-1-1V1a1 1 0 0 1 1-1z" opacity="0.65"/>
    <path d="M7 0l4 3.5H8a1 1 0 0 1-1-1V0z" opacity="0.4"/>
  </svg>;
}
