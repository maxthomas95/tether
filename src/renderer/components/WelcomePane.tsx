import type { EnvironmentInfo } from '../../shared/types';

interface WelcomePaneProps {
  environments: EnvironmentInfo[];
  enableResumePicker: boolean;
  onNewLocalSession: () => void;
  onConnectSsh: () => void;
  onOpenCoder: () => void;
  onResume: () => void;
}

export function WelcomePane({
  environments,
  enableResumePicker,
  onNewLocalSession,
  onConnectSsh,
  onOpenCoder,
  onResume,
}: WelcomePaneProps) {
  const hasSsh = environments.some(e => e.type === 'ssh');
  const hasCoder = environments.some(e => e.type === 'coder');

  return (
    <div className="welcome-pane">
      <div className="welcome-pane__hero">
        <WelcomeDiagram />
        <h1 className="welcome-pane__title">Welcome to Tether</h1>
        <p className="welcome-pane__subtitle">
          A single tether to every CLI session you run — local, remote, anywhere.
        </p>
      </div>

      <div className="welcome-pane__cards">
        <button type="button" className="welcome-card" onClick={onNewLocalSession}>
          <span className="welcome-card__kind">Local</span>
          <span className="welcome-card__title">New local session</span>
          <span className="welcome-card__desc">Run a CLI tool on this machine.</span>
        </button>
        <button type="button" className="welcome-card" onClick={onConnectSsh}>
          <span className="welcome-card__kind">SSH</span>
          <span className="welcome-card__title">Connect to SSH host</span>
          <span className="welcome-card__desc">
            {hasSsh ? 'Pick from your saved hosts.' : 'Set up a new SSH environment.'}
          </span>
        </button>
        <button type="button" className="welcome-card" onClick={onOpenCoder}>
          <span className="welcome-card__kind">Coder</span>
          <span className="welcome-card__title">Open Coder workspace</span>
          <span className="welcome-card__desc">
            {hasCoder ? 'Connect to a workspace.' : 'Add your Coder deployment.'}
          </span>
        </button>
      </div>

      {enableResumePicker && (
        <button
          type="button"
          className="welcome-pane__resume-link"
          onClick={onResume}
        >
          Resume a previous conversation
        </button>
      )}
    </div>
  );
}

/**
 * Three nodes (Local / SSH / Coder) tethered to a central anchor.
 * Lines pulse slowly from nodes toward the anchor — the metaphor.
 * Decorative; gated by prefers-reduced-motion in CSS.
 */
function WelcomeDiagram() {
  return (
    <svg
      className="welcome-diagram"
      viewBox="0 0 320 200"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
    >
      {/* Tether lines from each node to the anchor */}
      <g
        className="welcome-diagram__lines"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        fill="none"
      >
        <line x1="60" y1="46" x2="160" y2="148" />
        <line x1="160" y1="38" x2="160" y2="148" />
        <line x1="260" y1="46" x2="160" y2="148" />
      </g>

      {/* Pulse particles travel from each node down toward the anchor */}
      <g className="welcome-diagram__pulses" fill="currentColor">
        <circle r="2.4" className="welcome-diagram__pulse welcome-diagram__pulse--left" />
        <circle r="2.4" className="welcome-diagram__pulse welcome-diagram__pulse--mid" />
        <circle r="2.4" className="welcome-diagram__pulse welcome-diagram__pulse--right" />
      </g>

      {/* Three nodes — small chips, monospaced glyph inside */}
      <Node cx={60} cy={46} label="L" />
      <Node cx={160} cy={38} label="S" />
      <Node cx={260} cy={46} label="C" />

      {/* Central anchor — the tether */}
      <Anchor cx={160} cy={148} />
    </svg>
  );
}

function Node({ cx, cy, label }: { cx: number; cy: number; label: string }) {
  return (
    <g className="welcome-diagram__node">
      <circle cx={cx} cy={cy} r="14" />
      <text x={cx} y={cy + 4} textAnchor="middle" className="welcome-diagram__node-label">
        {label}
      </text>
    </g>
  );
}

function Anchor({ cx, cy }: { cx: number; cy: number }) {
  // Maritime anchor outline — top ring, vertical shank, curved flukes.
  // Sized to ~28px tall against the 320×200 viewBox.
  return (
    <g
      className="welcome-diagram__anchor"
      transform={`translate(${cx} ${cy})`}
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
    >
      {/* Top ring */}
      <circle cx="0" cy="-14" r="3.5" />
      {/* Crossbar (stock) */}
      <line x1="-7" y1="-7" x2="7" y2="-7" />
      {/* Shank */}
      <line x1="0" y1="-10.5" x2="0" y2="9" />
      {/* Curved flukes */}
      <path d="M -10 6 Q -10 14 0 14 Q 10 14 10 6" />
      {/* Center grounding dot */}
      <circle cx="0" cy="9" r="1.4" fill="currentColor" stroke="none" />
    </g>
  );
}
