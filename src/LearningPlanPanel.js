import React, { useEffect, useRef, useState } from 'react';
import { aiComplete } from './aiClient';
import {
  PLAN_SYSTEM_PROMPT, PLAN_ADJUST_SYSTEM_PROMPT,
  buildPlanUserContent, buildPlanAdjustContent,
  htmlToPlainText, parsePlan, planToNoteHtml,
} from './learningPlan';

export function LearningPlanIcon() {
  return <svg width="18" height="16" viewBox="0 0 18 16" fill="currentColor" aria-hidden="true">
    <path d="M9 0.5 L17.5 4 9 7.5 0.5 4Z"/>
    <path d="M4 6.2v3.3c0 1.5 2.2 2.7 5 2.7s5-1.2 5-2.7V6.2L9 8.3 4 6.2z" opacity="0.75"/>
    <rect x="16.2" y="4.6" width="1.3" height="5.4" rx="0.65" opacity="0.6"/>
  </svg>;
}

function FolderMiniIcon() {
  return <svg width="14" height="12" viewBox="0 0 15 13" fill="currentColor" aria-hidden="true">
    <path d="M0 2.5A1.5 1.5 0 0 1 1.5 1H5l1.5 2H13.5A1.5 1.5 0 0 1 15 4.5v7A1.5 1.5 0 0 1 13.5 13h-12A1.5 1.5 0 0 1 0 11.5V2.5z" opacity="0.8"/>
  </svg>;
}

// context describes how the panel was opened and sets the tree defaults:
//   { source: 'top' }                — everything collapsed, nothing selected
//   { source: 'folder', folderId }   — that folder open, all its notes selected
//   { source: 'note', noteId }       — the note's folder open, just it selected
export default function LearningPlanPanel({ notes, folders = [], context, onClose, onSaveAsNote }) {
  const [selected, setSelected] = useState(() => {
    if (context?.source === 'folder') {
      return new Set(notes.filter(n => n.folderId === context.folderId).map(n => n.id));
    }
    if (context?.source === 'note' && context.noteId) return new Set([context.noteId]);
    return new Set();
  });
  const [expandedFolders, setExpandedFolders] = useState(() => {
    if (context?.source === 'folder') return new Set([context.folderId]);
    if (context?.source === 'note') {
      const n = notes.find(x => x.id === context.noteId);
      return new Set(n && n.folderId ? [n.folderId] : []);
    }
    return new Set();
  });
  const [comments, setComments] = useState('');

  const [phase, setPhase] = useState('setup'); // setup | loading | done | error
  const [plan, setPlan] = useState(null);
  // Whether the generated plan was grounded in notes — a plan built purely
  // from the learner's description is saved into its own new folder.
  const [usedNotes, setUsedNotes] = useState(true);

  // Adjust-with-AI chat: plan stays visible; each message sends the current
  // plan + request and swaps in the revised plan.
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [chat, setChat] = useState([]); // [{ role: 'user'|'assistant', text }]
  const [chatInput, setChatInput] = useState('');
  const [adjusting, setAdjusting] = useState(false);
  const [baseContent, setBaseContent] = useState(''); // material the plan was built from
  const chatLogRef = useRef(null);

  useEffect(() => {
    if (chatLogRef.current) chatLogRef.current.scrollTop = chatLogRef.current.scrollHeight;
  }, [chat, adjusting]);
  const [error, setError] = useState(null);
  const [retrying, setRetrying] = useState(false);
  const abortRef = useRef(null);

  useEffect(() => () => { if (abortRef.current) abortRef.current.abort(); }, []);

  function toggleNote(id) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleFolderOpen(folderId) {
    setExpandedFolders(prev => {
      const next = new Set(prev);
      if (next.has(folderId)) next.delete(folderId); else next.add(folderId);
      return next;
    });
  }

  // Folder checkbox: selects/deselects every note inside it.
  function toggleFolderAll(folderId) {
    const ids = notes.filter(n => n.folderId === folderId).map(n => n.id);
    setSelected(prev => {
      const next = new Set(prev);
      const allIn = ids.length > 0 && ids.every(id => next.has(id));
      ids.forEach(id => { if (allIn) next.delete(id); else next.add(id); });
      return next;
    });
  }

  function renderNoteRow(n, indented) {
    return (
      <label key={n.id} className={`lp-note-row${indented ? ' lp-note-indent' : ''}`}>
        <input type="checkbox" checked={selected.has(n.id)} onChange={() => toggleNote(n.id)} />
        <span className="lp-note-name">{n.title || 'Untitled'}</span>
        <span className="lp-note-hint">{htmlToPlainText(n.content).slice(0, 40) || 'empty'}</span>
      </label>
    );
  }

  async function generate() {
    const sources = notes
      .filter(n => selected.has(n.id))
      .map(n => ({ title: n.title || 'Untitled', text: htmlToPlainText(n.content) }))
      .filter(s => s.text);
    if (!sources.length && !comments.trim()) {
      setError('Select at least one note, or describe what you want to learn.');
      setPhase('error');
      return;
    }
    setPhase('loading'); setError(null); setRetrying(false);
    setChat([]); setAdjustOpen(false);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const content = buildPlanUserContent(sources, { comments });
      const raw = await aiComplete({
        system: PLAN_SYSTEM_PROMPT,
        content,
        maxTokens: 4096,
        signal: controller.signal,
        onRetry: () => setRetrying(true),
      });
      setPlan(parsePlan(raw));
      setBaseContent(content);
      setUsedNotes(sources.length > 0);
      setPhase('done');
    } catch (e) {
      if (e.name === 'AbortError') return;
      setError(e.message || 'Something went wrong — please try again.');
      setPhase('error');
    }
  }

  function cancel() {
    if (abortRef.current) abortRef.current.abort();
    setPhase('setup');
  }

  function save() {
    onSaveAsNote(plan.title, planToNoteHtml(plan), { basedOnNotes: usedNotes });
  }

  async function sendAdjust() {
    const msg = chatInput.trim();
    if (!msg || adjusting) return;
    setChat(c => [...c, { role: 'user', text: msg }]);
    setChatInput('');
    setAdjusting(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const raw = await aiComplete({
        system: PLAN_ADJUST_SYSTEM_PROMPT,
        content: buildPlanAdjustContent(baseContent, plan, msg),
        maxTokens: 4096,
        signal: controller.signal,
      });
      setPlan(parsePlan(raw));
      setChat(c => [...c, { role: 'assistant', text: 'Done — the plan above is updated.' }]);
    } catch (e) {
      if (e.name === 'AbortError') return;
      setChat(c => [...c, { role: 'assistant', text: `Couldn't adjust the plan: ${e.message}` }]);
    } finally {
      setAdjusting(false);
    }
  }

  return (
    <div className="lp-overlay" onPointerDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="lp-panel" role="dialog" aria-label="Learning plan builder">
        <div className="lp-head">
          <span className="lp-head-icon"><LearningPlanIcon /></span>
          <span className="lp-head-title">Learning plan</span>
          <button className="lp-close" onPointerDown={onClose} title="Close">×</button>
        </div>

        {phase === 'setup' && (
          <div className="lp-body">
            <p className="lp-intro">Build a structured, milestone-based learning plan — from your notes, from a description of what you want to learn, or both.</p>
            <div className="lp-label">What do you want to learn?</div>
            <textarea
              className="lp-input lp-textarea"
              placeholder="Describe it in your own words — topic, current level, timeline, goal (e.g. 'conversational Italian for a trip in June, complete beginner, ~4 hours a week'). Leave empty to build purely from the selected notes."
              value={comments}
              onChange={e => setComments(e.target.value)}
              rows={3}
            />
            <div className="lp-label">Base it on notes (optional)</div>
            <div className="lp-note-list">
              {notes.filter(n => !n.folderId).map(n => renderNoteRow(n, false))}
              {folders.map(f => {
                const folderNotes = notes.filter(n => n.folderId === f.id);
                const selectedCount = folderNotes.filter(n => selected.has(n.id)).length;
                const allIn = folderNotes.length > 0 && selectedCount === folderNotes.length;
                const isOpen = expandedFolders.has(f.id);
                return (
                  <div key={f.id}>
                    <div className="lp-folder-row" onClick={() => toggleFolderOpen(f.id)}>
                      <span className={`lp-arrow${isOpen ? ' open' : ''}`}>▶</span>
                      <input
                        type="checkbox"
                        checked={allIn}
                        ref={el => { if (el) el.indeterminate = selectedCount > 0 && !allIn; }}
                        onClick={e => e.stopPropagation()}
                        onChange={() => toggleFolderAll(f.id)}
                        disabled={folderNotes.length === 0}
                      />
                      <span className="lp-folder-icon"><FolderMiniIcon /></span>
                      <span className="lp-note-name">{f.name}</span>
                      <span className="lp-note-hint">
                        {folderNotes.length === 0 ? 'empty' : `${selectedCount}/${folderNotes.length} selected`}
                      </span>
                    </div>
                    {isOpen && folderNotes.map(n => renderNoteRow(n, true))}
                  </div>
                );
              })}
            </div>
            <div className="lp-foot">
              <button
                className="lp-btn lp-btn-primary"
                onPointerDown={generate}
                disabled={!selected.size && !comments.trim()}
              >
                Generate plan
              </button>
            </div>
          </div>
        )}

        {phase === 'loading' && (
          <div className="lp-body lp-center">
            <div className="lp-spinner" />
            <p className="lp-status">{retrying ? 'Hit a snag — retrying…' : 'Designing your learning plan…'}</p>
            <button className="lp-btn" onPointerDown={cancel}>Cancel</button>
          </div>
        )}

        {phase === 'error' && (
          <div className="lp-body lp-center">
            <p className="lp-error">{error}</p>
            <div className="lp-foot">
              <button className="lp-btn" onPointerDown={() => setPhase('setup')}>Back</button>
              <button className="lp-btn lp-btn-primary" onPointerDown={generate}>Try again</button>
            </div>
          </div>
        )}

        {phase === 'done' && plan && (
          <div className="lp-body">
            <div className="lp-plan-title">{plan.title}</div>
            <div className="lp-plan-meta">~{plan.estimatedTotalHours} hours total · {plan.milestones.length} milestones</div>
            <div className="lp-milestones">
              {plan.milestones.map((m, i) => (
                <details className="lp-milestone" key={`${m.order}-${i}`} open={i === 0}>
                  <summary className="lp-m-summary">
                    <span className="lp-m-order">{m.order}</span>
                    <span className="lp-m-name">{m.name}</span>
                    <span className="lp-m-hours">~{m.estimatedHours}h</span>
                  </summary>
                  <div className="lp-m-body">
                    {m.objective && <p className="lp-m-objective">{m.objective}</p>}
                    {m.topics.length > 0 && (
                      <>
                        <div className="lp-m-label">Topics</div>
                        <ul className="lp-m-list">{m.topics.map((t, j) => <li key={j}>{t}</li>)}</ul>
                      </>
                    )}
                    {m.activities.length > 0 && (
                      <>
                        <div className="lp-m-label">Activities</div>
                        <ul className="lp-m-list">{m.activities.map((a, j) => <li key={j}>{a}</li>)}</ul>
                      </>
                    )}
                    {m.checkpoint && <p className="lp-m-checkpoint"><strong>Checkpoint:</strong> {m.checkpoint}</p>}
                  </div>
                </details>
              ))}
            </div>
            {plan.spacedRepetitionSuggestions.length > 0 && (
              <details className="lp-milestone lp-sr">
                <summary className="lp-m-summary">
                  <span className="lp-m-order">↻</span>
                  <span className="lp-m-name">Spaced repetition</span>
                </summary>
                <div className="lp-m-body">
                  <ul className="lp-m-list">{plan.spacedRepetitionSuggestions.map((s, j) => <li key={j}>{s}</li>)}</ul>
                </div>
              </details>
            )}
            {adjustOpen && (
              <div className="lp-chat">
                <div className="lp-chat-log" ref={chatLogRef}>
                  {chat.length === 0 && !adjusting && (
                    <div className="lp-msg lp-msg-assistant">
                      What should I change? e.g. “make milestone 2 shorter”, “add listening practice”, “fit it into 4 weeks”.
                    </div>
                  )}
                  {chat.map((m, i) => (
                    <div key={i} className={`lp-msg lp-msg-${m.role}`}>{m.text}</div>
                  ))}
                  {adjusting && <div className="lp-msg lp-msg-assistant lp-msg-busy">Adjusting the plan…</div>}
                </div>
                <div className="lp-chat-row">
                  <input
                    className="lp-input lp-chat-input"
                    placeholder="Tell the AI what to adjust…"
                    value={chatInput}
                    onChange={e => setChatInput(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); sendAdjust(); } }}
                    disabled={adjusting}
                    autoFocus
                  />
                  <button className="lp-btn lp-btn-primary" onPointerDown={sendAdjust} disabled={adjusting || !chatInput.trim()}>
                    Send
                  </button>
                </div>
              </div>
            )}
            <div className="lp-foot">
              <button className="lp-btn" onPointerDown={() => setPhase('setup')}>Regenerate</button>
              {!adjustOpen && (
                <button className="lp-btn" onPointerDown={() => setAdjustOpen(true)}>Adjust</button>
              )}
              <button className="lp-btn lp-btn-primary" onPointerDown={save}>Save as note</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
