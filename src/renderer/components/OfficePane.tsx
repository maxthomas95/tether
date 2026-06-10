interface OfficePaneProps {
  /** Base URL of the running J.O.B.S. server. */
  url: string;
  version: string | null;
  onClose: () => void;
}

/**
 * Embeds the J.O.B.S. pixel-art office as a guest page over the terminal
 * area. The webview is a plain web page with no preload and no node access;
 * it talks to the JOBS server over its own WebSocket, so closing the pane
 * costs nothing and reopening just replays the office snapshot.
 */
export function OfficePane({ url, version, onClose }: Readonly<OfficePaneProps>) {
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 20,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--bg-primary, #000)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '4px 10px',
          borderBottom: '1px solid var(--border-color, #333)',
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
          J.O.B.S. Office{version ? ` · v${version}` : ''}
        </span>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            className="form-btn"
            style={{ fontSize: 11, padding: '2px 8px' }}
            title="Open the office in your browser"
            onClick={() => window.electronAPI.shell.openExternal(url)}
          >
            Open in browser
          </button>
          <button
            className="form-btn"
            style={{ fontSize: 11, padding: '2px 8px' }}
            title="Back to terminals"
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </div>
      <webview src={url} style={{ flex: 1, width: '100%' }} />
    </div>
  );
}
