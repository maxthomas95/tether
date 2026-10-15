# Tether Helm MCP server

This private package translates stdio MCP calls from a local Claude Code parent
into authenticated requests to Tether's per-session bridge. Electron main owns
validation, permissions and session side effects. It is an experimental opt-in,
separate from passive native subagent rows and their read-only viewers.

Enable both **Settings → Sessions → Advanced session options → Allow Helm** and
the parent session's Helm toggle, then launch/restart that local Claude session.
Tether supplies `TETHER_HELM_SOCKET` and `TETHER_HELM_TOKEN` to the child process;
do not copy tokens into files or logs or expose the bridge as a public service.
Remote SSH/Coder parents are not wired to the local socket/resource path.

See the [user guide](../../src/docs/helm.md) for tools, inherited launch settings,
Coder workspace semantics, and limits. Tool schemas live in [src/index.ts](src/index.ts).
Helm can discover environments/profiles, spawn/query/kill sessions, and discover
or create Coder workspaces. It has no generic message broker or task scheduler.
Dispatched children use normal transports and their selected CLI permissions;
budget warnings do not enforce spending limits.

## Build and validate

From the repository root with Node 24/npm 10.9.4:

```bash
npx npm@10.9.4 --prefix mcp-servers/tether-helm ci
npm --prefix mcp-servers/tether-helm run build
npm --prefix mcp-servers/tether-helm audit --audit-level=high
```

Forge builds this package before packaging and copies its real directory to
`resources/tether-helm`, outside the ASAR, so Claude can spawn `dist/index.js`
using standalone Node on PATH. The app's `verify:package` check verifies the
packaged resource. CI builds/audits this package separately from app coverage.
