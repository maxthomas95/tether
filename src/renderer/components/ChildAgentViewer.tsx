import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ChildAgentInfo, ChildAgentTranscript } from '../../shared/child-agents';
import { useEscapeKey } from '../hooks/useEscapeKey';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { describeChildAgentTokens, formatChildAgentModel, formatChildAgentTiming, formatChildAgentTokens } from '../utils/child-agents';

interface ChildAgentViewerProps {
  sessionId: string;
  agent: ChildAgentInfo;
  onClose: () => void;
}

const REFRESH_MS = 3000;

/** Read-only view of what a subagent was asked and did. It has no terminal. */
export function ChildAgentViewer({ sessionId, agent, onClose }: Readonly<ChildAgentViewerProps>) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, true);
  useEscapeKey(onClose);
  const [transcript, setTranscript] = useState<ChildAgentTranscript | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'unavailable'>('loading');

  const current = transcript?.agent ?? agent;
  const running = current.state === 'running';

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      let next: ChildAgentTranscript | null = null;
      try { next = await window.electronAPI.subagents.transcript(sessionId, agent.id); } catch { /* shown as unavailable */ }
      if (!active) return;
      if (next) { setTranscript(next); setStatus('ready'); } else { setStatus(s => (s === 'ready' ? s : 'unavailable')); }
      if (next?.agent.state === 'running') timer = setTimeout(load, REFRESH_MS);
    };
    void load();
    return () => { active = false; if (timer) clearTimeout(timer); };
  }, [sessionId, agent.id]);

  const model = formatChildAgentModel(current);
  return createPortal(
    <div className="dialog-overlay child-agent-overlay" onMouseDown={onClose} role="presentation">
      <div
        ref={dialogRef}
        className="dialog child-agent-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`Subagent ${current.agentType}`}
        tabIndex={-1}
        onMouseDown={event => event.stopPropagation()}
      >
        <div className="dialog-header">
          <div>
            <h2>{current.agentType}</h2>
            <div className="session-inspector-subtitle" title={describeChildAgentTokens(current.tokens)}>
              {[current.description, model, formatChildAgentTiming(current, Date.now()), formatChildAgentTokens(current.tokens)].filter(Boolean).join(' · ')}
            </div>
          </div>
          <button className="dialog-close" aria-label="Close dialog" onClick={onClose}>&times;</button>
        </div>
        <div className="dialog-body child-agent-body">
          {status === 'loading' && <p className="form-hint" role="status">Loading transcript…</p>}
          {status === 'unavailable' && <p className="form-hint" role="status">This subagent&apos;s transcript is no longer available.</p>}
          {transcript && (
            <>
              <section>
                <h3 className="child-agent-heading">Task</h3>
                {transcript.prompt
                  ? <pre className="child-agent-text-block">{transcript.prompt}</pre>
                  : <p className="form-hint">No task text was recorded.</p>}
              </section>
              <section>
                <h3 className="child-agent-heading">Activity</h3>
                {transcript.truncated && <p className="form-hint">Showing the most recent activity only.</p>}
                {transcript.entries.length === 0
                  ? <p className="form-hint">{running ? 'Nothing yet.' : 'No tool calls or messages.'}</p>
                  : (
                    <ol className="child-agent-activity">
                      {transcript.entries.map((entry, index) => (
                        entry.kind === 'tool'
                          ? (
                            <li key={index} className="child-agent-tool">
                              <span className="child-agent-tool-name">{entry.name}</span>
                              {entry.summary && <span className="child-agent-tool-summary">{entry.summary}</span>}
                              {entry.failed && <span className="child-agent-tool-failed">failed</span>}
                            </li>
                          )
                          : <li key={index} className="child-agent-note-text">{entry.text}</li>
                      ))}
                    </ol>
                  )}
              </section>
              <section>
                <h3 className="child-agent-heading">Result</h3>
                {transcript.result
                  ? <pre className="child-agent-text-block">{transcript.result}</pre>
                  : <p className="form-hint">{running ? 'Still running.' : 'No final answer was recorded.'}</p>}
              </section>
            </>
          )}
        </div>
        <div className="dialog-footer">
          <button type="button" className="form-btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
