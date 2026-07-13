import React, { useEffect, useRef, useState } from 'react';
import { aiComplete } from './aiClient';
import { PLAN_SYSTEM_PROMPT, buildPlanUserContent, htmlToPlainText, parsePlan, planToNoteHtml } from './learningPlan';

export function LearningPlanIcon() {
  return <svg width="18" height="16" viewBox="0 0 18 16" fill="currentColor" aria-hidden="true">
    <path d="M9 0.5 L17.5 4 9 7.5 0.5 4Z"/>
    <path d="M4 6.2v3.3c0 1.5 2.2 2.7 5 2.7s5-1.2 5-2.7V6.2L9 8.3 4 6.2z" opacity="0.75"/>
    <rect x="16.2" y="4.6" width="1.3" height="5.4" rx="0.65" opacity="0.6"/>
  </svg>;
}

const LEVELS = ['Beginner', 'Intermediate', 'Advanced'];

export default function LearningPlanPanel({ notes, activeNoteId, onClose, onSaveAsNote }) {
  const [selected, setSelected] = useState(() => new Set(activeNoteId ? [activeNoteId] : []));
  const [level, setLevel] = useState('');
  const [weeklyHours, setWeeklyHours] = useState('');
  const [deadline, setDeadline] = useState('');
  const [goal, setGoal] = useState('');

  const [phase, setPhase] = useState('setup'); // setup | loading | done | error
  const [plan, setPlan] = useState(null);
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

  async function generate() {
    const sources = notes
      .filter(n => selected.has(n.id))
      .map(n => ({ title: n.title || 'Untitled', text: htmlToPlainText(n.content) }))
      .filter(s => s.text);
    if (!sources.length) {
      setError('The selected notes have no text content yet — write something first.');
      setPhase('error');
      return;
    }
    setPhase('loading'); setError(null); setRetrying(false);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const raw = await aiComplete({
        system: PLAN_SYSTEM_PROMPT,
        content: buildPlanUserContent(sources, { level, weeklyHours, deadline, goal }),
        maxTokens: 4096,
        signal: controller.signal,
        onRetry: () => setRetrying(true),
      });
      setPlan(parsePlan(raw));
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
    onSaveAsNote(plan.title, planToNoteHtml(plan));
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
            <p className="lp-intro">Turn your notes into a structured, milestone-based learning plan.</p>
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
            <div className="lp-label">Optional details</div>
            <div className="lp-params">
              <select className="lp-input" value={level} onChange={e => setLevel(e.target.value)}>
                <option value="">Level — any</option>
                {LEVELS.map(l => <option key={l} value={l}>{l}</option>)}
              </select>
              <input className="lp-input" type="number" min="1" max="80" placeholder="Hours / week"
                value={weeklyHours} onChange={e => setWeeklyHours(e.target.value)} />
              <input className="lp-input" type="date" title="Deadline"
                value={deadline} onChange={e => setDeadline(e.target.value)} />
              <input className="lp-input lp-input-goal" type="text" placeholder="Goal (e.g. pass the exam, build an app)"
                value={goal} onChange={e => setGoal(e.target.value)} />
            </div>
            <div className="lp-foot">
              <button className="lp-btn lp-btn-primary" onPointerDown={generate} disabled={!selected.size}>
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
            <div className="lp-foot">
              <button className="lp-btn" onPointerDown={() => setPhase('setup')}>Adjust</button>
              <button className="lp-btn" onPointerDown={generate}>Regenerate</button>
              <button className="lp-btn lp-btn-primary" onPointerDown={save}>Save as note</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
