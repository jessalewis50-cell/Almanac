import React, { useState, useRef, useCallback, useEffect, useImperativeHandle, useMemo } from 'react';
import './App.css';
import { supabase } from './supabaseClient';
import LearningPlanPanel, { LearningPlanIcon } from './LearningPlanPanel';
import RestructurePanel, { RestructureIcon } from './RestructurePanel';
import { searchNotes, stripSearchHighlights } from './noteSearch';
import { authHeaders, AIError } from './aiClient';
import { FindBar, SearchResults } from './FindBar';
import { motion, useAnimation } from 'framer-motion';
import ReactQuill from 'react-quill-new';
import 'react-quill-new/dist/quill.snow.css';
import Quill from 'quill';

// Font: class-based so Quill stores value as ql-font-<name>; CSS in App.css maps classes to font-family.
const Font = Quill.import('formats/font');
Font.whitelist = ['arial', 'times-new-roman', 'courier-new', 'georgia', 'verdana', 'helvetica'];
Quill.register(Font, true);

// Size: style-based attributor; whitelist of pt values so only known sizes are accepted.
const Size = Quill.import('attributors/style/size');
Size.whitelist = ['10pt','12pt','14pt','16pt','18pt','20pt','22pt','24pt','26pt','28pt'];
Quill.register(Size, true);

// Dedicated search-highlight format (classes ql-sh-on / ql-sh-active).
// Separate from Quill's real background format so applying/clearing it can
// never disturb the user's own formatting. Always applied with source
// 'silent' so it never emits text-change / triggers autosave.
const Parchment = Quill.import('parchment');
const SearchHighlightAttr = new Parchment.ClassAttributor('search-highlight', 'ql-sh', {
  scope: Parchment.Scope.INLINE,
  whitelist: ['on', 'active'],
});
Quill.register(SearchHighlightAttr, true);

// Stable module and format configs — must live outside App so the object/array references
// never change. ReactQuill reinitializes Quill (resetting cursor to 0) whenever any
// dirtyProp (modules, formats, bounds, theme, children) receives a new reference.
const QUILL_MODULES = { toolbar: false };
const QUILL_FORMATS = ['bold', 'italic', 'underline', 'list', 'indent', 'align', 'color', 'font', 'size', 'search-highlight'];

// Memoized wrapper so Quill never remounts due to unrelated App re-renders.
const QuillEditor = React.memo(React.forwardRef(function QuillEditor(
  { className, placeholder, onChange, onChangeSelection }, ref
) {
  return (
    <ReactQuill
      ref={ref}
      theme="snow"
      modules={QUILL_MODULES}
      formats={QUILL_FORMATS}
      className={className}
      placeholder={placeholder}
      onChange={onChange}
      onChangeSelection={onChangeSelection}
    />
  );
}));

const FONT_FAMILIES = [
  { label: 'Arial',           value: 'arial' },
  { label: 'Georgia',         value: 'georgia' },
  { label: 'Times New Roman', value: 'times-new-roman' },
  { label: 'Courier New',     value: 'courier-new' },
  { label: 'Verdana',         value: 'verdana' },
  { label: 'Helvetica',       value: 'helvetica' },
];
const FONT_SIZES = ['10pt','12pt','14pt','16pt','18pt','20pt','22pt','24pt','26pt','28pt'];

function makeNote(folderId = null) {
  return { id: 'local-' + Date.now(), title: 'Untitled', content: '', strokes: [], updatedAt: new Date().toISOString(), folderId };
}
function isLocalId(id) { return typeof id === 'string' && id.startsWith('local-'); }
function mapNote(row) {
  return { id: row.id, userId: row.user_id, title: row.title || 'Untitled', content: row.content || '', strokes: [], updatedAt: row.updated_at, folderId: row.folder_id || null };
}
function stripHtml(h) {
  return h.replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
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

// ── Breadcrumb bar ──────────────────────────────────────────────────────────────

function BreadcrumbBar({ note, folder, onRenameTitle }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const startEdit = () => { setDraft(note?.title || ''); setEditing(true); };
  const commit = () => {
    setEditing(false);
    const t = draft.trim() || 'Untitled';
    if (t !== (note?.title || 'Untitled')) onRenameTitle(t);
  };

  return (
    <div className="breadcrumb">
      <span className="bc-crumb">Almanac</span>
      {folder && (
        <>
          <span className="bc-sep">›</span>
          <span className="bc-crumb">{folder.name}</span>
        </>
      )}
      <span className="bc-sep">›</span>
      {editing ? (
        <input
          className="bc-title-input"
          value={draft}
          autoFocus
          onChange={e => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false); }}
        />
      ) : (
        <span className="bc-title" onClick={startEdit}>{note?.title || 'Untitled'}</span>
      )}
    </div>
  );
}

// ── AI credits meter (sidebar footer) ──────────────────────────────────────────
// Percent of the monthly AI budget used — never raw dollars or tokens. Data
// comes from /api/usage (same auth as the AI proxy); hidden for guests and
// while loading.
function UsageMeter({ session }) {
  const [meter, setMeter] = useState(null);

  useEffect(() => {
    if (!session) { setMeter(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const auth = await authHeaders();
        const res = await fetch('/api/usage', { headers: auth });
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) setMeter(data);
      } catch { /* meter is decorative — fail silently */ }
    })();
    return () => { cancelled = true; };
  }, [session]);

  if (!session || !meter) return null;

  const resets = new Date(meter.resets_at)
    .toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

  if (meter.budget_microdollars <= 0) {
    return (
      <div className="sb-usage">
        <div className="sb-usage-row"><span>AI features are part of Almanac Pro.</span></div>
      </div>
    );
  }

  const pct = meter.percent_used;
  const atLimit = pct >= 100;
  return (
    <div className="sb-usage">
      <div className="sb-usage-row">
        <span className={atLimit ? 'sb-usage-alert' : ''}>
          AI credits · {pct}% used — resets {resets}
        </span>
        <button
          className="sb-usage-btn"
          title="Top-ups coming soon: $3 → $1.50 of credits, $5 → $3.00 of credits"
        >
          Get more
        </button>
      </div>
      <div className="sb-usage-track">
        <div
          className={`sb-usage-fill${atLimit ? ' sb-usage-fill-limit' : ''}`}
          style={{ width: `${Math.min(100, pct)}%` }}
        />
      </div>
    </div>
  );
}

// ── Notebook Cover (Framer Motion) ─────────────────────────────────────────────

function NotebookCover({ onSignIn, onSignUp, onGuest, onForgotPassword, error, info, loading, opening }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const coverControls = useAnimation();
  const sceneControls = useAnimation();

  useEffect(() => {
    if (!opening) return;
    (async () => {
      // Phase 1 — Lift: cover rises off the desk (0–500ms)
      await coverControls.start({
        z: 22,
        scale: 1.02,
        boxShadow: '0 22px 65px rgba(0,0,0,0.75), 0 0 80px rgba(124,108,255,0.28)',
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

        {/* Spine — hardcover binding strip */}
        <div className="nb-spine" />

        {/* Perspective container for 3D cover */}
        <div className="nb-perspective">
          <motion.div
            className="nb-cover-3d"
            animate={coverControls}
            initial={{
              rotateY: 0, scale: 1, z: 0, opacity: 1,
              boxShadow: '0 10px 40px rgba(0,0,0,0.65), 0 0 60px rgba(124,108,255,0.18)',
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
                    <h1 className="nb-title">Almanac</h1>
                  </div>
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
                  {info && <div className="nb-info">{info}</div>}
                  <div className="nb-btn-row">
                    <button className="nb-btn-primary" onClick={() => onSignIn(email, password)} disabled={loading}>
                      {loading ? 'Please wait…' : 'Sign In'}
                    </button>
                    <button className="nb-btn-secondary" onClick={() => onSignUp(email, password)} disabled={loading}>
                      Sign Up
                    </button>
                  </div>
                  <button
                    className="nb-btn-ghost nb-forgot"
                    onClick={() => onForgotPassword(email)}
                    disabled={loading}
                  >
                    Forgot password?
                  </button>
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

// ── Password reset screen (after clicking the emailed recovery link) ──────────

function PasswordResetScreen({ onDone }) {
  const [pw1, setPw1] = useState('');
  const [pw2, setPw2] = useState('');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  async function submit() {
    if (pw1.length < 6) { setError('Password must be at least 6 characters.'); return; }
    if (pw1 !== pw2)    { setError('Passwords do not match.'); return; }
    setLoading(true); setError(null);
    const { error: err } = await supabase.auth.updateUser({ password: pw1 });
    setLoading(false);
    if (err) { setError(err.message); return; }
    onDone();
  }

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <h1 className="auth-title">Set a new password</h1>
        <div className="auth-fields">
          <input
            className="auth-input" type="password" placeholder="New password"
            value={pw1} autoFocus
            onChange={e => setPw1(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && submit()}
            autoComplete="new-password"
          />
          <input
            className="auth-input" type="password" placeholder="Confirm new password"
            value={pw2}
            onChange={e => setPw2(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && submit()}
            autoComplete="new-password"
          />
        </div>
        {error && <div className="auth-error">{error}</div>}
        <button className="auth-btn primary" onClick={submit} disabled={loading}>
          {loading ? 'Saving…' : 'Save new password'}
        </button>
      </div>
    </div>
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
  const [authInfo, setAuthInfo]       = useState(null);
  const [authLoading, setAuthLoading] = useState(false);
  const [recoveryMode, setRecoveryMode] = useState(false);

  // Notes & folders
  const [notes, setNotes]                         = useState([makeNote()]);
  const [activeId, setActiveId]                   = useState(null);
  const [folders, setFolders]                     = useState([]);
  const [expandedFolderIds, setExpandedFolderIds] = useState(new Set());
  const [activeFolderId, setActiveFolderId]       = useState(null);
  const [renamingFolderId, setRenamingFolderId]   = useState(null);
  const [renamingNoteId, setRenamingNoteId]       = useState(null);
  // Folder view: when set, the main pane shows the folder's notes as tiles
  // instead of the editor (which stays mounted but hidden — unmounting Quill
  // would lose its live content, since content is only pasted on note switch).
  const [viewFolderId, setViewFolderId]           = useState(null);

  // UI
  const [drawMode, setDrawMode]         = useState(false);
  const [eraserActive, setEraserActive] = useState(false);
  const [converting, setConverting]     = useState(false);
  const [convertError, setConvertError] = useState(null);
  const [saveStatus, setSaveStatus]     = useState('idle');
  const [formats, setFormats]           = useState({});
  const [color, setColor]               = useState('#000000');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  // null | { source: 'top' } | { source: 'folder', folderId } | { source: 'note', noteId }
  const [showPlanPanel, setShowPlanPanel]       = useState(null);
  const [showRestructure, setShowRestructure]   = useState(false);
  // Pre-restructure snapshot for one-click revert: { noteId, html } | null
  const [restructureBackup, setRestructureBackup] = useState(null);

  // Search (sidebar) + in-note find session { query } | null
  const [searchQuery, setSearchQuery]     = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [findSession, setFindSession]     = useState(null);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(searchQuery), 250);
    return () => clearTimeout(t);
  }, [searchQuery]);

  // Refs
  const quillRef          = useRef(null);   // ReactQuill component ref
  const editorScrollRef   = useRef(null);
  const drawingCanvasRef  = useRef(null);
  const savedQuillRange   = useRef(null);   // last Quill selection before toolbar focus
  const lastSelectionRef  = useRef(null);   // last known non-null selection (fallback for buttons)
  const notesRef          = useRef(notes);
  const sessionRef        = useRef(session);
  const autosaveTimerRef  = useRef(null);
  const prevEidRef        = useRef(null);
  // Stores the latest typed HTML per note id without triggering React re-renders.
  // doAutosave reads from here; React state is only updated at autosave time.
  const pendingContentRef = useRef({});
  // True while a Supabase save is in flight — prevents eid-effect from resetting editor.
  const isSavingRef = useRef(false);
  // Set by doAutosave when a new note's local id transitions to its Supabase id.
  // The eid effect reads this to skip the content paste on that specific transition.
  const autosaveIdTransitionRef = useRef(null);

  useEffect(() => { notesRef.current = notes; }, [notes]);
  useEffect(() => { sessionRef.current = session; }, [session]);

  // Derived
  const eid        = (activeId && notes.find(n => n.id === activeId)) ? activeId : notes[0]?.id;
  const activeNote = notes.find(n => n.id === eid) || notes[0];
  const viewFolder = viewFolderId ? (folders.find(f => f.id === viewFolderId) || null) : null;
  const viewFolderNotes = viewFolder ? notes.filter(n => n.folderId === viewFolder.id) : [];

  // Cross-note search results (signed-in: notes from loadAll; guest: the
  // notes-v2 localStorage set already loaded into state). Pending keystrokes
  // are overlaid so fresh typing is searchable.
  const searchResults = useMemo(() => {
    if (!debouncedQuery.trim()) return null;
    const src = notes.map(n => ({
      ...n,
      content: pendingContentRef.current[n.id] !== undefined ? pendingContentRef.current[n.id] : n.content,
      folderName: n.folderId ? (folders.find(f => f.id === n.folderId)?.name || null) : null,
    }));
    return searchNotes(src, debouncedQuery);
  }, [notes, folders, debouncedQuery]);

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
        setRecoveryMode(false);
      } else if (event === 'PASSWORD_RECOVERY') {
        // Arrived via an emailed reset link: Supabase has already established
        // a session, but the user must set a new password before entering the
        // app — recoveryMode takes render precedence over cover and app.
        setSession(newSession); setRecoveryMode(true); setShowApp(false); setOpeningBook(false);
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

  // Auto-expand the folder that contains the currently active note
  useEffect(() => {
    if (activeNote?.folderId) {
      setExpandedFolderIds(prev => new Set([...prev, activeNote.folderId]));
    }
  }, [activeNote?.folderId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Autosave on note switch + sync editor content
  useEffect(() => {
    let isIdTransition = false;

    if (prevEidRef.current && prevEidRef.current !== eid) {
      // Detect autosave ID transition (local- id → Supabase integer id).
      // In that case the editor already has the right content — skip paste and double-save.
      const t = autosaveIdTransitionRef.current;
      isIdTransition = !!(t && t.from === prevEidRef.current && t.to === eid);
      autosaveIdTransitionRef.current = null;

      if (!isIdTransition) {
        // Real note switch: flush the outgoing note, then load the incoming one below.
        if (autosaveTimerRef.current) { clearTimeout(autosaveTimerRef.current); autosaveTimerRef.current = null; }
        doAutosave(prevEidRef.current);
      }
    }

    prevEidRef.current = eid;

    // Only paste content into the editor on a real note switch, never on autosave transitions.
    if (!isIdTransition) {
      const quillInst = quillRef.current?.getEditor();
      if (quillInst) {
        const newContent = pendingContentRef.current[eid] ?? activeNote?.content ?? '';
        if (quillInst.root.innerHTML !== newContent) {
          quillInst.clipboard.dangerouslyPasteHTML(newContent);
          quillInst.setSelection(0, 0, 'silent');
        }
      }
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
    if (!note) return;
    // Read content fresh from the editor if it's still the active note; otherwise use the
    // pending buffer (editor shows a different note after a note switch).
    const editorInst = quillRef.current?.getEditor();
    // stripSearchHighlights: belt-and-suspenders — search highlights must
    // never reach storage, whichever source the content comes from.
    const content = stripSearchHighlights(
      pendingContentRef.current[noteId]
        ?? (editorInst ? editorInst.root.innerHTML : note.content)
    );

    const sess = sessionRef.current;
    // Guest mode: flush to React state so the localStorage effect fires.
    if (!sess) {
      setNotes(p => p.map(n => n.id === noteId ? { ...n, content, updatedAt: new Date().toISOString() } : n));
      delete pendingContentRef.current[noteId];
      return;
    }

    isSavingRef.current = true;
    setSaveStatus('saving');
    const now = new Date().toISOString();
    const isNew = isLocalId(note.id);
    try {
      if (isNew) {
        const { data, error } = await supabase.from('notes')
          .insert({ title: note.title || 'Untitled', content: content || '', user_id: sess.user.id, folder_id: note.folderId || null })
          .select().single();
        if (error) throw error;
        const saved = mapNote(data);
        // Transfer pending buffer to the new Supabase id so any post-save keystrokes aren't lost.
        if (pendingContentRef.current[noteId] !== undefined) {
          pendingContentRef.current[saved.id] = pendingContentRef.current[noteId];
        }
        delete pendingContentRef.current[noteId];
        // Signal the eid effect that the upcoming eid change is an id transition, not a note switch.
        autosaveIdTransitionRef.current = { from: noteId, to: saved.id };
        setNotes(p => p.map(n => n.id === noteId ? { ...saved, strokes: n.strokes } : n));
        setActiveId(cur => cur === noteId ? saved.id : cur);
      } else {
        const { error } = await supabase.from('notes')
          .update({ title: note.title, content, updated_at: now })
          .eq('id', note.id);
        if (error) throw error;
        delete pendingContentRef.current[noteId];
        // Write the saved content back into state so the sidebar preview and
        // cross-note search see fresh edits. Safe for the editor: QuillEditor
        // is uncontrolled and memoized, and the eid effect only pastes content
        // on an actual note switch — a state update alone never touches the
        // editor DOM or cursor. (An older version skipped content here as a
        // cursor-protection measure; that hazard no longer exists.)
        setNotes(p => p.map(n => n.id === noteId ? { ...n, content, updatedAt: now } : n));
      }
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus(s => s === 'saved' ? 'idle' : s), 2000);
    } catch { setSaveStatus('error'); }
    finally { isSavingRef.current = false; }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function scheduleAutosave(noteId) {
    if (!sessionRef.current) return;
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = setTimeout(() => doAutosave(noteId), 3000);
  }

  // ── Auth handlers ──────────────────────────────────────────────────────────

  async function handleSignIn(email, password) {
    setAuthLoading(true); setAuthError(null); setAuthInfo(null);
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) { setAuthError(error.message); setAuthLoading(false); return; }
    setAuthLoading(false);
    setSession(data.session);
    setOpeningBook(true);
    setTimeout(() => { setShowApp(true); }, 1900);    // app fades in 300ms before scene finishes
    setTimeout(() => { setOpeningBook(false); }, 2300); // unmount cover after animation ends
  }

  async function handleSignUp(email, password) {
    setAuthLoading(true); setAuthError(null); setAuthInfo(null);
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

  async function handleForgotPassword(email) {
    if (!email || !email.trim()) {
      setAuthInfo(null);
      setAuthError('Enter your email above first.');
      return;
    }
    setAuthLoading(true); setAuthError(null); setAuthInfo(null);
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: window.location.origin,
    });
    setAuthLoading(false);
    if (error) {
      // Real failures only (rate limit, malformed email) — Supabase does not
      // error for unknown addresses, so this never leaks registration status.
      setAuthError(error.message);
    } else {
      setAuthInfo('If an account exists for that email, a reset link is on its way.');
    }
  }

  function handleRecoveryDone() {
    // Drop the recovery token from the URL so a reload doesn't re-trigger
    // recovery mode; the session is already valid, go straight to the app.
    window.history.replaceState(null, '', window.location.pathname);
    setRecoveryMode(false);
    setShowApp(true);
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

  // Mirrors renameFolder: double-click a sidebar note title to rename it.
  async function renameNote(id, name) {
    const trimmed = (name || '').trim() || 'Untitled';
    const now = new Date().toISOString();
    setNotes(p => p.map(n => n.id === id ? { ...n, title: trimmed, updatedAt: now } : n));
    setRenamingNoteId(null);
    // Local-id notes get their title persisted by the first autosave insert;
    // guest notes persist via the localStorage effect on setNotes.
    if (sessionRef.current && !isLocalId(id)) {
      await supabase.from('notes').update({ title: trimmed, updated_at: now }).eq('id', id);
    }
  }

  async function renameFolder(id, name) {
    const trimmed = (name || '').trim() || 'New Folder';
    await supabase.from('folders').update({ name: trimmed }).eq('id', id);
    setFolders(p => p.map(f => f.id === id ? { ...f, name: trimmed } : f));
    setRenamingFolderId(null);
  }

  async function deleteFolder(id, name) {
    if (!window.confirm(`Delete folder "${name}" and all its notes? This cannot be undone.`)) return;
    console.log('Attempting to delete folder:', id);
    if (session) {
      try {
        const { error: notesErr } = await supabase.from('notes').delete().eq('folder_id', id).eq('user_id', session.user.id);
        if (notesErr) { console.error('Supabase delete folder notes error:', JSON.stringify(notesErr)); alert(`Failed to delete folder notes: ${notesErr.message}`); return; }
        const { error: folderErr } = await supabase.from('folders').delete().eq('id', id).eq('user_id', session.user.id);
        if (folderErr) { console.error('Supabase delete folder error:', JSON.stringify(folderErr)); alert(`Failed to delete folder: ${folderErr.message}`); return; }
      } catch (err) {
        console.error('Exception deleting folder:', err);
        alert(`Exception deleting folder: ${err.message}`);
        return;
      }
    }
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
    setViewFolderId(v => (v === id ? null : v));
    setExpandedFolderIds(prev => { const next = new Set(prev); next.delete(id); return next; });
  }

  // ── Note CRUD ──────────────────────────────────────────────────────────────

  const newNote = useCallback(() => {
    const n = makeNote(null);
    setNotes(p => [n, ...p]); setActiveId(n.id);
    setViewFolderId(null);
  }, []);

  const newNoteInFolder = useCallback((folderId) => {
    const n = makeNote(folderId);
    setNotes(p => [n, ...p]); setActiveId(n.id);
    setExpandedFolderIds(prev => new Set([...prev, folderId]));
    setViewFolderId(null);
  }, []);

  const openNote = useCallback((id) => { setActiveId(id); setViewFolderId(null); }, []);

  // Enter folder view (from either sidebar state); drawing mode is a
  // note-editing mode, so leave it when the editor goes off-screen.
  const openFolderView = useCallback((folderId) => {
    setViewFolderId(folderId);
    setDrawMode(false);
    setEraserActive(false);
  }, []);

  // Create a note from generated HTML, reusing the existing persistence flow:
  // seeding pendingContentRef makes the eid effect paste the content into the
  // editor, and doAutosave insert it through the normal path (guest mode
  // persists via the localStorage effect instead). If created from folder
  // view, the new note lands in that folder.
  const createNoteFromHtml = useCallback((title, html) => {
    const n = { ...makeNote(viewFolderId || null), title, content: html };
    pendingContentRef.current[n.id] = html;
    setNotes(p => [n, ...p]);
    setActiveId(n.id);
    setViewFolderId(null);
    scheduleAutosave(n.id);
  }, [viewFolderId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Plans grounded in notes save as a plain note; plans built purely from the
  // learner's description get their own new folder with the plan note inside.
  // (Folders need a session — guests fall back to a plain note.)
  const savePlanAsNote = useCallback(async (title, html, opts = {}) => {
    const planTitle = title || 'Learning Plan';
    if (opts.basedOnNotes === false && sessionRef.current) {
      const { data: folder, error } = await supabase.from('folders')
        .insert({ name: planTitle, user_id: sessionRef.current.user.id })
        .select().single();
      if (!error && folder) {
        setFolders(p => [...p, folder]);
        setExpandedFolderIds(s => new Set([...s, folder.id]));
        const n = { ...makeNote(folder.id), title: planTitle, content: html };
        pendingContentRef.current[n.id] = html;
        setNotes(p => [n, ...p]);
        setActiveId(n.id);
        setViewFolderId(null);
        scheduleAutosave(n.id);
        setShowPlanPanel(null);
        return;
      }
      // Folder creation failed — fall through and at least save the note.
    }
    createNoteFromHtml(planTitle, html);
    setShowPlanPanel(null);
  }, [createNoteFromHtml]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveRestructureAsNote = useCallback((title, html) => {
    createNoteFromHtml(title || 'Restructured note', html);
    setShowRestructure(false);
  }, [createNoteFromHtml]);

  // ── Restructure apply/revert ───────────────────────────────────────────────
  // Both paste into the live editor and persist through the normal autosave
  // machinery (immediate doAutosave flush for guests, debounced for sessions).

  const setEditorHtml = useCallback((html) => {
    const quill = quillRef.current?.getEditor();
    if (!quill) return null;
    quill.clipboard.dangerouslyPasteHTML(html);
    quill.setSelection(0, 0, 'silent');
    return quill.root.innerHTML; // what Quill actually kept
  }, []);

  const applyRestructure = useCallback((newHtml) => {
    const quill = quillRef.current?.getEditor();
    if (!quill) return;
    setRestructureBackup({ noteId: eid, html: stripSearchHighlights(quill.root.innerHTML) });
    const finalHtml = setEditorHtml(newHtml);
    if (finalHtml === null) return;
    pendingContentRef.current[eid] = finalHtml;
    if (sessionRef.current) scheduleAutosave(eid); else doAutosave(eid);
    setShowRestructure(false);
  }, [eid, doAutosave, setEditorHtml]); // eslint-disable-line react-hooks/exhaustive-deps

  const revertRestructure = useCallback(() => {
    if (!restructureBackup || restructureBackup.noteId !== eid) return;
    const finalHtml = setEditorHtml(restructureBackup.html);
    if (finalHtml === null) return;
    pendingContentRef.current[eid] = finalHtml;
    if (sessionRef.current) scheduleAutosave(eid); else doAutosave(eid);
    setRestructureBackup(null);
  }, [restructureBackup, eid, doAutosave, setEditorHtml]); // eslint-disable-line react-hooks/exhaustive-deps

  const deleteNote = useCallback(async (id, e) => {
    e.stopPropagation();
    const fullNote = notesRef.current.find(n => n.id === id);
    console.log('Attempting to delete note id:', id, '(type:', typeof id, ')');
    console.log('Full note object:', JSON.stringify(fullNote));
    console.log('Session user_id:', session?.user?.id);
    console.log('Note userId field:', fullNote?.userId);

    if (session && !isLocalId(id)) {
      try {
        // First try with user_id filter (RLS-friendly)
        const { data, error, status, statusText } = await supabase
          .from('notes')
          .delete()
          .eq('id', id)
          .eq('user_id', session.user.id)
          .select();
        console.log('Delete response:', status, statusText);
        console.log('Delete error:', JSON.stringify(error));
        console.log('Delete data:', JSON.stringify(data));

        if (error) {
          // If filtering by user_id failed, try without it (catches user_id mismatch)
          console.warn('Retrying delete without user_id filter to check RLS vs mismatch...');
          const { data: d2, error: e2, status: s2, statusText: st2 } = await supabase
            .from('notes')
            .delete()
            .eq('id', id)
            .select();
          console.log('Retry response:', s2, st2);
          console.log('Retry error:', JSON.stringify(e2));
          console.log('Retry data:', JSON.stringify(d2));
          if (e2) {
            console.error('Both delete attempts failed. Final error:', JSON.stringify(e2));
            alert(`Failed to delete note: ${e2.message}`);
            return;
          }
        }
      } catch (err) {
        console.error('Exception deleting note:', err);
        alert(`Exception deleting note: ${err.message}`);
        return;
      }
    }
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
    // Store latest content in a ref — no setState, so no re-render on every keystroke.
    // doAutosave (and guest-mode persistence) flush this to React state on the 2s debounce.
    // stripSearchHighlights: never let find-mode highlight spans into the buffer.
    pendingContentRef.current[eid] = stripSearchHighlights(quill.root.innerHTML);
    scheduleAutosave(eid);
  }, [eid]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Editor / format handlers ───────────────────────────────────────────────

  // Save Quill selection — called from onMouseDown on selects/color (before focus leaves).
  // Never overwrites with null; only updates when editor still has focus.
  const saveQuillRange = useCallback(() => {
    const quill = quillRef.current?.getEditor();
    if (!quill) return;
    const sel = quill.getSelection();
    if (sel !== null) {
      savedQuillRange.current = sel;
      lastSelectionRef.current = sel;
    }
  }, []);

  // Restore saved Quill selection so format commands from selects/color hit the right text
  const restoreQuillRange = useCallback(() => {
    const quill = quillRef.current?.getEditor();
    if (!quill) return;
    quill.focus();
    const range = savedQuillRange.current ?? lastSelectionRef.current;
    if (range) {
      quill.setSelection(range.index, range.length, 'silent');
    }
  }, []);

  const refreshFormats = useCallback(() => {
    const quill = quillRef.current?.getEditor();
    if (!quill) { setFormats({}); return; }
    // getFormat() with no args calls getSelection(true), which FORCE-FOCUSES
    // the editor — stealing focus from any other input (find bar, title
    // fields) the moment the editor blurs. Read the selection without
    // focusing and keep the last formats when the editor isn't focused.
    const sel = quill.getSelection();
    if (!sel) return;
    const f = quill.getFormat(sel.index, sel.length);
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

  // Stable handlers passed to QuillEditor — must not be recreated on every App render
  // so React.memo on QuillEditor can bail out during unrelated state changes.
  const handleEditorChange = useCallback((_, __, source) => {
    if (source === 'user') {
      // Editing while find mode is open closes it (Word-style); the FindBar
      // cleanup then removes all highlight spans from the editor.
      setFindSession(null);
      onEditorInput();
      if (!isSavingRef.current) setSidebarCollapsed(true);
    }
  }, [onEditorInput]);

  const handleSelectionChange = useCallback((range) => {
    if (range) {
      savedQuillRange.current = range;
      lastSelectionRef.current = range;
    }
    refreshFormats();
  }, [refreshFormats]);

  const execBtn = useCallback((e, cmd) => {
    e.preventDefault();
    const quill = quillRef.current?.getEditor();
    if (!quill) return;

    // List commands: if getSelection() returns null (can happen on first click before focus
    // settles), focus and apply after a 10ms delay so the DOM has time to register focus.
    if (cmd === 'insertUnorderedList' || cmd === 'insertOrderedList') {
      const listType = cmd === 'insertUnorderedList' ? 'bullet' : 'ordered';
      const sel = quill.getSelection();
      if (!sel) {
        quill.focus();
        setTimeout(() => {
          const q = quillRef.current?.getEditor();
          if (!q) return;
          const s = lastSelectionRef.current;
          if (s) q.setSelection(s.index, s.length, 'silent');
          const fmt = q.getFormat();
          q.format('list', fmt.list === listType ? false : listType);
          refreshFormats();
        }, 10);
        return;
      }
      const f = quill.getFormat();
      quill.format('list', f.list === listType ? false : listType);
      refreshFormats();
      return;
    }

    // onMouseDown+preventDefault keeps editor focus, so getSelection() returns the live range.
    // Fall back to lastSelectionRef on touch devices or if focus was lost some other way.
    let sel = quill.getSelection();
    if (!sel) {
      quill.focus();
      sel = lastSelectionRef.current;
      if (sel) quill.setSelection(sel.index, sel.length, 'silent');
    }
    const f = quill.getFormat();
    switch (cmd) {
      case 'bold':          quill.format('bold',      !f.bold);      break;
      case 'italic':        quill.format('italic',    !f.italic);    break;
      case 'underline':     quill.format('underline', !f.underline); break;
      case 'justifyLeft':   quill.format('align',     false);        break;
      case 'justifyCenter': quill.format('align',     'center');     break;
      case 'justifyRight':  quill.format('align',     'right');      break;
      case 'indent':        quill.format('indent', '+1');            break;
      case 'outdent':       quill.format('indent', '-1');            break;
      default: break;
    }
    refreshFormats();
  }, [refreshFormats]);

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
          headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
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
        console.error('API error:', response.status, eb);
        if ((eb?.code === 'upgrade_required' || eb?.code === 'limit_reached') && eb?.error) {
          throw new AIError(eb.error, { status: response.status, retryable: false });
        }
        throw new Error(`HTTP ${response.status}`);
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
      setConvertError(err instanceof AIError ? err.message : 'Could not convert handwriting — please try again.');
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
        <div className="sb-note-title">
          <span className="sb-note-icon"><DocumentIcon /></span>
          {renamingNoteId === n.id ? (
            <input
              className="sb-note-rename-input"
              defaultValue={n.title} autoFocus
              onClick={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()}
              onBlur={e => renameNote(n.id, e.target.value)}
              onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') setRenamingNoteId(null); }}
            />
          ) : (
            <span onDoubleClick={e => { e.stopPropagation(); setRenamingNoteId(n.id); }}>
              {n.title || 'Untitled'}
            </span>
          )}
        </div>
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
      {/* Recovery mode wins over both cover and app: a reset link must land
          on the password form, never silently log the user in. */}
      {recoveryMode && <PasswordResetScreen onDone={handleRecoveryDone} />}

      {/* Main app — only shown after animation completes */}
      {!recoveryMode && showApp && (session || isGuest) && (
        <motion.div
          className="app"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.4, ease: 'easeOut' }}
        >
          <div
            className={`sidebar${sidebarCollapsed ? ' collapsed' : ''}`}
            onPointerDown={() => { if (sidebarCollapsed) setSidebarCollapsed(false); }}
          >
            {sidebarCollapsed ? (
              <>
                <button
                  className="sb-toggle"
                  onPointerDown={e => { e.stopPropagation(); setSidebarCollapsed(c => !c); }}
                  title="Expand sidebar"
                >
                  ›
                </button>
                <div className="sb-mini-actions">
                  <button className="sb-mini-btn" onPointerDown={e => { e.stopPropagation(); setSidebarCollapsed(false); newNote(); }} title="New Note">+</button>
                </div>
              </>
            ) : (
              <div className="sb-header">
                <div className="sb-actions">
                  <button className="sb-btn sb-btn-primary" onPointerDown={newNote}>+ New Note</button>
                  {session && <button className="sb-btn sb-btn-secondary" onPointerDown={createFolder}>+ Folder</button>}
                </div>
                <button
                  className="sb-toggle sb-toggle-inline"
                  onPointerDown={e => { e.stopPropagation(); setSidebarCollapsed(c => !c); }}
                  title="Collapse sidebar"
                >
                  ‹
                </button>
              </div>
            )}
            {!sidebarCollapsed && (
              <div className="sb-search-wrap">
                <input
                  className="sb-search"
                  placeholder="Search notes…"
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Escape') { setSearchQuery(''); setFindSession(null); } }}
                />
                {searchQuery && (
                  <button
                    className="sb-search-clear"
                    onPointerDown={() => { setSearchQuery(''); setFindSession(null); }}
                    title="Clear search"
                  >×</button>
                )}
              </div>
            )}
            <div className="sb-list">
              {sidebarCollapsed ? (
                <>
                  {notes.filter(n => !n.folderId).map(n => (
                    <div
                      key={n.id}
                      className={`sb-note-mini${n.id === eid ? ' active' : ''}`}
                      onPointerDown={e => { e.stopPropagation(); setSidebarCollapsed(false); openNote(n.id); }}
                      title={n.title || 'Untitled'}
                    >
                      <DocumentIcon />
                    </div>
                  ))}
                  {session && folders.map(folder => {
                    const folderNotes = notes.filter(n => n.folderId === folder.id);
                    const containsActive = folderNotes.some(n => n.id === eid);
                    return (
                      <div
                        key={folder.id}
                        className={`sb-folder-mini${containsActive ? ' active' : ''}`}
                        onPointerDown={e => { e.stopPropagation(); setSidebarCollapsed(false); setActiveFolderId(folder.id); toggleFolder(folder.id); openFolderView(folder.id); }}
                        title={folder.name}
                      >
                        <FolderIcon />
                      </div>
                    );
                  })}
                </>
              ) : searchResults ? (
                <SearchResults
                  results={searchResults}
                  onOpen={(id) => { openNote(id); setFindSession({ query: debouncedQuery }); }}
                />
              ) : (
                <>
                  {notes.filter(n => !n.folderId).map(n => renderSbNote(n))}
                  {session && folders.map(folder => {
                    const isExpanded = expandedFolderIds.has(folder.id);
                    const folderNotes = notes.filter(n => n.folderId === folder.id);
                    const containsActive = folderNotes.some(n => n.id === eid);
                    return (
                      <div key={folder.id} className="sb-folder">
                        <div
                          className={`sb-folder-head${activeFolderId === folder.id || containsActive ? ' active' : ''}`}
                          onPointerDown={() => { setActiveFolderId(folder.id); toggleFolder(folder.id); openFolderView(folder.id); }}
                        >
                          <span className={`sb-folder-arrow${isExpanded ? ' open' : ''}`}>▶</span>
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
                          <button className="sb-folder-add" onPointerDown={e => { e.stopPropagation(); newNoteInFolder(folder.id); }} title="New note in folder">+</button>
                          <button className="sb-del sb-del-folder" onPointerDown={e => { e.stopPropagation(); deleteFolder(folder.id, folder.name); }} title="Delete folder">×</button>
                        </div>
                        {isExpanded && (
                          <div className="sb-folder-notes">
                            {folderNotes.map(n => renderSbNote(n, true))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </>
              )}
            </div>
            {!sidebarCollapsed && <UsageMeter session={session} />}
          </div>

          <div className="main">
            <div className="topbar">
              <div className="topbar-logo" aria-label="Almanac">
                <span className="topbar-logo-text">Almanac</span>
              </div>
              <button
                className="topbar-plan-btn"
                onPointerDown={() => setShowPlanPanel({ source: 'top' })}
                title="Build Learning Plan"
              >
                <LearningPlanIcon />
                <span>Learning Plan</span>
              </button>
              {session && saveStatus !== 'idle' && (
                <span className={`save-status save-status-${saveStatus}`}>
                  {saveStatus === 'saving' ? 'Saving…' : saveStatus === 'saved' ? 'Saved ✓' : 'Save failed'}
                </span>
              )}
              {session ? (
                <div className="user-area" style={{ marginLeft: 'auto' }}>
                  <span className="user-email">{session.user.email}</span>
                  <button className="tbtn signout-btn" onPointerDown={handleSignOut}>Sign Out</button>
                </div>
              ) : (
                <button className="tbtn signout-btn" style={{ marginLeft: 'auto' }} onPointerDown={handleGuestSignIn}>Sign In</button>
              )}
            </div>

            {viewFolder ? (
              <div className="breadcrumb">
                <span className="bc-crumb">Almanac</span>
                <span className="bc-sep">›</span>
                <span className="bc-title">{viewFolder.name}</span>
              </div>
            ) : (
              <BreadcrumbBar
                note={activeNote}
                folder={activeNote?.folderId ? folders.find(f => f.id === activeNote.folderId) : null}
                onRenameTitle={setTitle}
              />
            )}

            <div className="toolbar" role="toolbar">
              {!viewFolder && <>
              <div className="toolbar-group">
                <select className="tb-select font-select" defaultValue="arial" onMouseDown={saveQuillRange} onChange={applyFont}>
                  {FONT_FAMILIES.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
                </select>
                <select className="tb-select size-select" defaultValue="16pt" onMouseDown={saveQuillRange} onChange={applySize}>
                  {FONT_SIZES.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <span className="tb-div" />
              <div className="toolbar-group">
                <button className={tbtn(formats.bold)}      onMouseDown={e => execBtn(e,'bold')}      title="Bold"><b>B</b></button>
                <button className={tbtn(formats.italic)}    onMouseDown={e => execBtn(e,'italic')}    title="Italic"><i>I</i></button>
                <button className={tbtn(formats.underline)} onMouseDown={e => execBtn(e,'underline')} title="Underline"><u>U</u></button>
              </div>
              <span className="tb-div" />
              <div className="toolbar-group">
                <label className="tbtn color-btn" title="Text color"
                  onMouseDown={e => { e.preventDefault(); saveQuillRange(); }}
                >
                  <span className="color-a" style={{ '--c': color }}>A</span>
                  <input type="color" value={color} onChange={applyColor} className="sr-only" />
                </label>
              </div>
              <span className="tb-div" />
              <div className="toolbar-group">
                <button className={tbtn(formats.justifyLeft)}   onMouseDown={e => execBtn(e,'justifyLeft')}   title="Left"><AlignLeftIcon /></button>
                <button className={tbtn(formats.justifyCenter)} onMouseDown={e => execBtn(e,'justifyCenter')} title="Center"><AlignCenterIcon /></button>
                <button className={tbtn(formats.justifyRight)}  onMouseDown={e => execBtn(e,'justifyRight')}  title="Right"><AlignRightIcon /></button>
              </div>
              <span className="tb-div" />
              <div className="toolbar-group">
                <button className={tbtn(formats.insertUnorderedList)} onMouseDown={e => execBtn(e,'insertUnorderedList')} title="Bullets"><BulletListIcon /></button>
                <button className={tbtn(formats.insertOrderedList)}   onMouseDown={e => execBtn(e,'insertOrderedList')}   title="Numbers"><span className="list-num">1.</span></button>
              </div>
              <span className="tb-div" />
              <div className="toolbar-group">
                <button className="tbtn" onMouseDown={e => execBtn(e,'outdent')} title="Decrease indent"><OutdentIcon /></button>
                <button className="tbtn" onMouseDown={e => execBtn(e,'indent')}  title="Increase indent"><IndentIcon /></button>
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
              <span className="tb-div" />
              </>}
              <div className="toolbar-group">
                <button
                  className="tbtn"
                  onPointerDown={() => setShowPlanPanel(viewFolder
                    ? { source: 'folder', folderId: viewFolder.id }
                    : { source: 'note', noteId: eid })}
                  title="Build Learning Plan"
                >
                  <LearningPlanIcon />
                </button>
                <button className="tbtn" onPointerDown={() => setShowRestructure(true)} title="Restructure note">
                  <RestructureIcon />
                </button>
              </div>
            </div>

            {findSession && !viewFolder && (
              <FindBar
                quillRef={quillRef}
                contentKey={eid}
                initialQuery={findSession.query}
                // Closing either search surface dismisses both.
                onClose={() => { setFindSession(null); setSearchQuery(''); }}
              />
            )}

            {restructureBackup && restructureBackup.noteId === eid && !viewFolder && (
              <div className="restore-bar">
                <span>Note restructured — the previous version is kept until you dismiss this.</span>
                <button className="restore-btn" onPointerDown={revertRestructure}>Revert</button>
                <button className="restore-dismiss" onPointerDown={() => setRestructureBackup(null)} title="Dismiss">×</button>
              </div>
            )}

            {isGuest && (
              <div className="guest-banner">
                Guest mode — notes are not saved to the cloud. Use <strong>Sign In</strong> above to keep your notes.
              </div>
            )}

            {drawMode && <div className="scroll-zone-hint" />}

            {viewFolder && (
              <div className="folder-view">
                <div className="fv-grid">
                  {viewFolderNotes.map(n => (
                    <div key={n.id} className="fv-tile" onPointerDown={() => openNote(n.id)} title={n.title || 'Untitled'}>
                      <span className="fv-icon"><DocumentIcon /></span>
                      <span className="fv-name">{n.title || 'Untitled'}</span>
                    </div>
                  ))}
                  <div className="fv-tile fv-tile-new" onPointerDown={() => newNoteInFolder(viewFolder.id)} title="New note in this folder">
                    <span className="fv-icon fv-plus">+</span>
                    <span className="fv-name">New note</span>
                  </div>
                </div>
                {viewFolderNotes.length === 0 && (
                  <p className="fv-empty">This folder is empty — create its first note.</p>
                )}
              </div>
            )}

            {/* Editor stays mounted (hidden) in folder view so Quill's live
                content survives; it is only re-pasted on note switches. */}
            <div className="editor-scroll" ref={editorScrollRef} style={viewFolder ? { display: 'none' } : undefined}>
              <div className="editor-layer">
                <div key="editor-stable">
                  <QuillEditor
                    ref={quillRef}
                    className={`quill-editor${drawMode ? ' draw-mode' : ''}`}
                    placeholder="Start typing your note…"
                    onChange={handleEditorChange}
                    onChangeSelection={handleSelectionChange}
                  />
                </div>
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
            {showPlanPanel && (
              <LearningPlanPanel
                // Overlay unsaved keystrokes: fresh typing lives in pendingContentRef
                // until the next autosave flush, so state alone can be stale/empty.
                notes={notes.map(n => (
                  pendingContentRef.current[n.id] !== undefined
                    ? { ...n, content: pendingContentRef.current[n.id] }
                    : n
                ))}
                folders={folders}
                context={showPlanPanel}
                onClose={() => setShowPlanPanel(null)}
                onSaveAsNote={savePlanAsNote}
              />
            )}
            {showRestructure && (
              <RestructurePanel
                // Same pending-keystroke overlay as the plan panel.
                notes={notes.map(n => (
                  pendingContentRef.current[n.id] !== undefined
                    ? { ...n, content: pendingContentRef.current[n.id] }
                    : n
                ))}
                activeNoteId={eid}
                initialSelectedIds={viewFolder ? viewFolderNotes.map(n => n.id) : undefined}
                onClose={() => setShowRestructure(false)}
                onApply={applyRestructure}
                onSaveAsNote={saveRestructureAsNote}
              />
            )}
          </div>
        </motion.div>
      )}

      {/* Notebook cover — kept in DOM until 100ms after animation so crossfade can overlap */}
      {!recoveryMode && (!showApp || openingBook) && (
        <NotebookCover
          onSignIn={handleSignIn} onSignUp={handleSignUp}
          onGuest={handleGuestMode} onForgotPassword={handleForgotPassword}
          error={authError} info={authInfo} loading={authLoading}
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
function DocumentIcon() {
  return <svg width="11" height="13" viewBox="0 0 11 13" fill="currentColor" aria-hidden="true">
    <path d="M1 0h6.5L11 3.5V12a1 1 0 0 1-1 1H1a1 1 0 0 1-1-1V1a1 1 0 0 1 1-1z" opacity="0.65"/>
    <path d="M7 0l4 3.5H8a1 1 0 0 1-1-1V0z" opacity="0.4"/>
  </svg>;
}
