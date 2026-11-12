import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react';
import type { ChildAgentInfo, ChildAgentTranscript } from '../../shared/child-agents';
import { useNow } from '../hooks/useNow';
import {
  CHILD_AGENT_PANEL_KEY_STEP,
  CHILD_AGENT_PANEL_MAX_WIDTH,
  CHILD_AGENT_PANEL_MIN_WIDTH,
  clampChildAgentPanelWidth,
  isLongTask,
} from '../utils/child-agent-panel';
import { childAgentKind, describeChildAgentTokens, formatChildAgentModel, formatChildAgentTiming, formatChildAgentTokens } from '../utils/child-agents';
import { Icon } from './Icon';

interface ChildAgentViewerProps {
  sessionId: string;
  /** Label of the session the agent belongs to, shown above its name. */
  sessionLabel?: string;
  /** The row as the sidebar shows it now. Give the panel a `key` per agent. */
  agent: ChildAgentInfo;
  width: number;
  /** Opened from the keyboard, so focus moves into the panel. */
  focusOnOpen?: boolean;
  onClose: (restoreFocus?: boolean) => void;
  onResize: (width: number) => void;
  /** Called once when a drag or key resize ends, with the final width. */
  onResizeEnd?: (width: number) => void;
}

const REFRESH_MS = 3000;
/** Failed reads of a running agent tolerated in a row before the panel stops asking. */
const MAX_FAILED_READS = 3;
/** Within this distance of the end, new activity keeps the view at the end. */
const FOLLOW_SLACK_PX = 48;

/**
 * Read-only view of what a subagent was asked and did, docked beside the
 * terminal area. It is not a dialog: the terminals stay usable while it is
 * open, and Escape closes it only when focus is inside it, because Escape in a
 * terminal belongs to the CLI.
 */
export function ChildAgentViewer({
  sessionId, sessionLabel, agent, width, focusOnOpen = false, onClose, onResize, onResizeEnd,
}: Readonly<ChildAgentViewerProps>) {
  const panelRef = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const resultRef = useRef<HTMLElement>(null);
  const [transcript, setTranscript] = useState<ChildAgentTranscript | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  /** A read failed after one had worked, so what is shown may be behind. */
  const [stale, setStale] = useState(false);
  const [taskOpen, setTaskOpen] = useState(false);

  const agentId = agent.id;
  const running = agent.state === 'running';
  const now = useNow(running);
  const runningRef = useRef(running);
  runningRef.current = running;
  /** Read again; `now` skips the wait for the next poll. */
  const refresh = useRef<((now: boolean) => void) | null>(null);

  useEffect(() => {
    let active = true;
    let busy = false;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      if (!active || busy) return;
      busy = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      let next: ChildAgentTranscript | null = null;
      try { next = await window.electronAPI.subagents.transcript(sessionId, agentId); } catch { /* shown as unavailable */ }
      busy = false;
      if (!active) return;
      if (next) {
        failures = 0;
        setTranscript(next);
        setStatus('ready');
        setStale(false);
      } else {
        failures++;
        setStatus(s => (s === 'ready' ? s : 'unavailable'));
        setStale(true);
      }
      const again = next ? next.agent.state === 'running' : runningRef.current && failures < MAX_FAILED_READS;
      if (again) timer = setTimeout(load, REFRESH_MS);
    };
    refresh.current = soon => { if (!busy && (soon || !timer)) void load(); };
    void load();
    return () => {
      active = false;
      refresh.current = null;
      if (timer) clearTimeout(timer);
      window.electronAPI.subagents.releaseTranscript(sessionId, agentId);
    };
  }, [sessionId, agentId]);

  // The sidebar row is pushed from main. A start or an end is read at once, so
  // the answer shows as soon as the row turns gray; other activity only wakes a
  // panel that had stopped polling, and never adds reads to one that is polling.
  useEffect(() => { refresh.current?.(true); }, [agent.state]);
  useEffect(() => { refresh.current?.(false); }, [agent.lastActivityAt]);

  useEffect(() => {
    if (focusOnOpen) panelRef.current?.focus();
  }, [focusOnOpen]);

  /** Whether the shown transcript is of an agent that was still working when it was read. */
  const working = transcript?.agent.state === 'running' && !stale;

  // While it works, stay at the newest activity unless the reader scrolled away.
  // Once it has finished, start at the answer.
  const follow = useRef(true);
  const placed = useRef(false);
  const wasWorking = useRef(false);
  const onBodyScroll = useCallback(() => {
    const el = bodyRef.current;
    if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_SLACK_PX;
  }, []);
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el || !transcript) return;
    if (working) {
      if (follow.current) el.scrollTop = el.scrollHeight;
    } else if (!placed.current || (wasWorking.current && follow.current)) {
      el.scrollTop = Math.max(0, (resultRef.current?.offsetTop ?? 0) - 8);
    }
    placed.current = true;
    wasWorking.current = working;
  }, [transcript, working]);

  const onPanelKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    onClose(true);
  };

  const onHandleMouseDown = useCallback((event: ReactMouseEvent) => {
    event.preventDefault();
    let last: number | null = null;
    const onMove = (e: MouseEvent) => {
      const right = panelRef.current?.getBoundingClientRect().right ?? window.innerWidth;
      last = clampChildAgentPanelWidth(right - e.clientX);
      onResize(last);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      if (last !== null) onResizeEnd?.(last);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [onResize, onResizeEnd]);

  const onHandleKeyDown = (event: ReactKeyboardEvent) => {
    // The handle sits on the panel's left edge, so Left makes the panel wider.
    const step = event.key === 'ArrowLeft' ? CHILD_AGENT_PANEL_KEY_STEP : event.key === 'ArrowRight' ? -CHILD_AGENT_PANEL_KEY_STEP : 0;
    if (!step) return;
    event.preventDefault();
    event.stopPropagation();
    const next = clampChildAgentPanelWidth(width + step);
    onResize(next);
    onResizeEnd?.(next);
  };

  const kind = childAgentKind(agent);
  const meta = [formatChildAgentModel(agent), formatChildAgentTiming(agent, now), formatChildAgentTokens(agent.tokens)].filter(Boolean).join(' · ');
  const prompt = transcript?.prompt ?? null;
  const foldable = prompt !== null && isLongTask(prompt);

  return (
    <>
      <div
        className="child-agent-panel-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize subagent panel"
        aria-valuemin={CHILD_AGENT_PANEL_MIN_WIDTH}
        aria-valuemax={CHILD_AGENT_PANEL_MAX_WIDTH}
        aria-valuenow={width}
        tabIndex={0}
        onMouseDown={onHandleMouseDown}
        onKeyDown={onHandleKeyDown}
      />
      <aside
        ref={panelRef}
        className="child-agent-panel"
        style={{ width }}
        aria-label={`${kind} ${agent.agentType}`}
        tabIndex={-1}
        onKeyDown={onPanelKeyDown}
      >
        <header className="child-agent-panel-header">
          <div className="child-agent-panel-heading">
            <div className="child-agent-panel-eyebrow">{sessionLabel ? `${kind} · ${sessionLabel}` : kind}</div>
            <h2 className="child-agent-panel-title">
              <span className={`status-dot status-dot--${running ? 'running' : 'idle'}`} aria-hidden="true" />
              <span>{agent.agentType}</span>
            </h2>
            {agent.description && <div className="child-agent-panel-description">{agent.description}</div>}
            <div className="child-agent-panel-meta" title={describeChildAgentTokens(agent.tokens)}>{meta}</div>
          </div>
          <button type="button" className="icon-button" aria-label="Close subagent panel" title="Close (Esc)" onClick={() => onClose()}>
            <Icon name="close" />
          </button>
        </header>
        <div ref={bodyRef} className="child-agent-panel-body" onScroll={onBodyScroll}>
          {status === 'loading' && <p className="form-hint" role="status">Loading transcript…</p>}
          {status === 'unavailable' && <p className="form-hint" role="status">This subagent&apos;s transcript is no longer available.</p>}
          {transcript && (
            <>
              {stale && <p className="form-hint" role="status">Tether can no longer read this transcript, so what is shown may be out of date.</p>}
              {transcript.note && <p className="form-hint">{transcript.note}</p>}
              <section>
                <h3 className="child-agent-heading">Task</h3>
                {prompt === null
                  ? <p className="form-hint">No task text was recorded.</p>
                  : (
                    <>
                      <div className={`child-agent-text${foldable && !taskOpen ? ' child-agent-text--folded' : ''}`}>{prompt}</div>
                      {foldable && (
                        <button type="button" className="child-agent-fold" aria-expanded={taskOpen} onClick={() => setTaskOpen(open => !open)}>
                          {taskOpen ? 'Show less' : 'Show full task'}
                        </button>
                      )}
                    </>
                  )}
              </section>
              <section>
                <h3 className="child-agent-heading">
                  Activity{transcript.entries.length > 0 && <span className="child-agent-count">{transcript.entries.length}</span>}
                </h3>
                {transcript.truncated && <p className="form-hint">Showing the task from the start and only the most recent activity. Earlier activity is not shown.</p>}
                {transcript.entries.length === 0
                  ? <p className="form-hint">{working ? 'Nothing yet.' : 'No tool calls or messages.'}</p>
                  : (
                    <ol className="child-agent-activity">
                      {transcript.entries.map((entry, index) => (
                        entry.kind === 'tool'
                          ? (
                            <li key={index} className="child-agent-tool">
                              <span className="child-agent-tool-name">{entry.name}</span>
                              {entry.summary && <span className="child-agent-tool-summary" title={entry.summary}>{entry.summary}</span>}
                              {entry.failed && <span className="child-agent-tool-failed">failed</span>}
                            </li>
                          )
                          : <li key={index} className="child-agent-note-text">{entry.text}</li>
                      ))}
                    </ol>
                  )}
              </section>
              <section ref={resultRef}>
                <h3 className="child-agent-heading">Result</h3>
                {transcript.result
                  ? <div className="child-agent-text child-agent-text--result">{transcript.result}</div>
                  : <p className="form-hint">{working ? 'Still running.' : 'No final answer was recorded.'}</p>}
                {transcript.result && transcript.resultTruncated && <p className="form-hint">The answer is longer than Tether shows; its end is missing.</p>}
              </section>
            </>
          )}
        </div>
      </aside>
    </>
  );
}
