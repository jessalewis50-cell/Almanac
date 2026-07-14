import React, { useEffect, useRef, useState } from 'react';
import { aiComplete } from './aiClient';
import { htmlToPlainText } from './learningPlan';
import {
  PURPOSES, inferPurpose,
  buildRestructureSystemPrompt, buildRestructureUserContent,
  sanitizeQuillHtml,
} from './restructure';

export function RestructureIcon() {
  return <svg width="18" height="16" viewBox="0 0 18 16" fill="currentColor" aria-hidden="true">
    <rect x="0" y="1" width="11" height="2" rx="1"/>
    <rect x="0" y="7" width="14" height="2" rx="1"/>
    <rect x="0" y="13" width="8" height="2" rx="1"/>
    <path d="M15.5 1 L18 3.5 15.5 6z" opacity="0.85"/>
    <path d="M12.5 15 L10 12.5 12.5 10z" opacity="0.85"/>
  </svg>;
}

// Destination rule: if the selection is exactly the active note, "apply"
// overwrites it in place (with the revert banner). Any other selection —
// multiple notes, or a single non-active note — is saved as a NEW note, so
// source notes are never destructively merged.

export default function RestructurePanel({ notes, activeNoteId, initialSelectedIds, onClose, onApply, onSaveAsNote }) {
  const defaultIds = initialSelectedIds && initialSelectedIds.length
    ? initialSelectedIds
    : (activeNoteId ? [activeNoteId] : []);
  const [selected, setSelected] = useState(() => new Set(defaultIds));
  const [suggested] = useState(() => {
    const idSet = new Set(defaultIds);
    const text = notes.filter(n => idSet.has(n.id)).map(n => htmlToPlainText(n.content)).join('\n');
    return inferPurpose(text);
  });
  const [purpose, setPurpose] = useState(suggested);
  const [freeform, setFreeform] = useState('');
  const [phase, setPhase] = useState('setup'); // setup | loading | preview | error
  const [resultHtml, setResultHtml] = useState('');
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

  const chosen = notes.filter(n => selected.has(n.id));
  const singleActive = selected.size === 1 && selected.has(activeNoteId);
  const purposeLabel = (PURPOSES.find(p => p.id === purpose) || PURPOSES[0]).label;

  async function generate() {
    const sources = chosen
      .map(n => ({ title: n.title || 'Untitled', text: htmlToPlainText(n.content) }))
      .filter(s => s.text);
    if (!sources.length) {
      setError('The selected notes have no text content to restructure yet.');
      setPhase('error');
      return;
    }
    setPhase('loading'); setError(null); setRetrying(false);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const raw = await aiComplete({
        system: buildRestructureSystemPrompt(purpose, freeform.trim(), sources.length > 1),
        content: buildRestructureUserContent(sources),
        maxTokens: 8192,
        signal: controller.signal,
        onRetry: () => setRetrying(true),
      });
      setResultHtml(sanitizeQuillHtml(raw));
      setPhase('preview');
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

  function confirmResult() {
    if (singleActive) {
      onApply(resultHtml);
    } else {
      const title = chosen.length === 1
        ? `${chosen[0].title || 'Untitled'} (restructured)`
        : `Restructured: ${purposeLabel}`;
      onSaveAsNote(title, resultHtml);
    }
  }

  return (
    <div className="lp-overlay" onPointerDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="lp-panel" role="dialog" aria-label="Restructure notes">
        <div className="lp-head">
          <span className="lp-head-icon"><RestructureIcon /></span>
          <span className="lp-head-title">Restructure notes</span>
          <button className="lp-close" onPointerDown={onClose} title="Close">×</button>
        </div>

        {phase === 'setup' && (
          <div className="lp-body">
            <p className="lp-intro">
              Reorganize your notes for a purpose — content stays, structure changes.
              Nothing is overwritten until you confirm the preview.
            </p>
            <div className="lp-label">Notes to include</div>
            <div className="lp-note-list">
              {notes.map(n => (
                <label key={n.id} className="lp-note-row">
                  <input type="checkbox" checked={selected.has(n.id)} onChange={() => toggleNote(n.id)} />
                  <span className="lp-note-name">{n.title || 'Untitled'}</span>
                  <span className="lp-note-hint">{htmlToPlainText(n.content).slice(0, 40) || 'empty'}</span>
                </label>
              ))}
            </div>
            <div className="lp-label">Purpose</div>
            <div className="rs-chips">
              {PURPOSES.map(p => (
                <button
                  key={p.id}
                  className={`rs-chip${purpose === p.id ? ' active' : ''}`}
                  onPointerDown={() => setPurpose(p.id)}
                >
                  {p.label}
                  {suggested === p.id && suggested !== 'tidy' && <span className="rs-suggested">suggested</span>}
                </button>
              ))}
            </div>
            <input
              className="lp-input"
              type="text"
              placeholder="Optional: add your own instructions (e.g. keep it under one page)"
              value={freeform}
              onChange={e => setFreeform(e.target.value)}
            />
            <div className="lp-foot">
              <button className="lp-btn lp-btn-primary" onPointerDown={generate} disabled={!selected.size}>
                Preview restructure
              </button>
            </div>
          </div>
        )}

        {phase === 'loading' && (
          <div className="lp-body lp-center">
            <div className="lp-spinner" />
            <p className="lp-status">{retrying ? 'Hit a snag — retrying…' : `Restructuring for ${purposeLabel.toLowerCase()}…`}</p>
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

        {phase === 'preview' && (
          <div className="lp-body">
            <p className="lp-intro">
              Preview — <strong>{purposeLabel}</strong>{chosen.length > 1 ? `, ${chosen.length} notes merged` : ''}.{' '}
              {singleActive
                ? 'Applying overwrites this note — a one-click revert stays available.'
                : 'The result will be saved as a new note; your source notes stay untouched.'}
            </p>
            <div
              className="rs-preview"
              /* Safe by construction: resultHtml has passed sanitizeQuillHtml,
                 a serialize-from-parse allowlist (9 tags, no attributes except
                 a regex-validated font-size, text re-escaped, script/style
                 subtrees removed). See restructure.js. */
              dangerouslySetInnerHTML={{ __html: resultHtml }}
            />
            <div className="lp-foot">
              <button className="lp-btn" onPointerDown={() => setPhase('setup')}>Back</button>
              <button className="lp-btn" onPointerDown={generate}>Regenerate</button>
              <button className="lp-btn lp-btn-primary" onPointerDown={confirmResult}>
                {singleActive ? 'Apply to note' : 'Save as new note'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
