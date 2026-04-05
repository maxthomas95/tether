# Changelog — Tether

All notable changes to this project will be documented in this file.

---

## [0.1.0-alpha.1] — 2026-04-04

The first working build. Tether runs as a standalone Windows exe.

### Core
- Electron + React + TypeScript app with xterm.js terminal
- Multiple concurrent Claude Code sessions with instant switching
- Session sidebar with environment groups and auto-grouping by repo
- Passive status detection — green (running), amber (waiting), gray (idle), red (dead)
- JSON file persistence — environments and sessions survive app restarts

### Session Management
- Create sessions via directory picker or repos root quick-pick
- Right-click context menu: Rename, Duplicate, Stop, Kill, Remove
- Keyboard shortcuts: Ctrl+N (new), Ctrl+1-9 (switch), Ctrl+Up/Down (navigate), Ctrl+B (toggle sidebar), Ctrl+W (stop)
- Resizable sidebar with drag handle

### Environment Variables
- 3-level cascade: App defaults -> Environment -> Session override
- Reusable EnvVarEditor with Quick Add presets for common Claude Code vars
- Sensitive value masking (API keys, tokens)
- Settings dialog for app-level defaults

### Multi-Environment
- Local sessions via node-pty (ConPTY on Windows)
- SSH transport adapter (ssh2) with preconfigured host/port/user/key presets
- New Environment dialog for SSH configuration

### Known Issues
- VS 2025 not recognized by node-gyp — using prebuilt N-API binaries and JSON persistence instead of SQLite
- Status detection heuristics may need tuning across different Claude Code versions
- No error toasts yet — errors show in DevTools console only
