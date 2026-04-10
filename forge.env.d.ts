/// <reference types="@electron-forge/plugin-vite/forge-vite-env" />

// Forge VitePlugin auto-generates these globals for each renderer entry.
declare const DOCS_WINDOW_VITE_DEV_SERVER_URL: string;
declare const DOCS_WINDOW_VITE_NAME: string;

// Vite raw string imports for markdown files.
declare module '*.md?raw' {
  const content: string;
  export default content;
}

// electron-squirrel-startup ships no types. The default export is a boolean:
// true if the process was launched by Squirrel for an install/update/uninstall
// lifecycle event (and the app should quit), false otherwise.
declare module 'electron-squirrel-startup' {
  const startedBySquirrel: boolean;
  export default startedBySquirrel;
}
