/// <reference types="@electron-forge/plugin-vite/forge-vite-env" />

// electron-squirrel-startup ships no types. The default export is a boolean:
// true if the process was launched by Squirrel for an install/update/uninstall
// lifecycle event (and the app should quit), false otherwise.
declare module 'electron-squirrel-startup' {
  const startedBySquirrel: boolean;
  export default startedBySquirrel;
}
