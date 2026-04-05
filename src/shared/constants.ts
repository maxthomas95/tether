export const IPC = {
  // Renderer -> Main
  SESSION_CREATE: 'session:create',
  SESSION_STOP: 'session:stop',
  SESSION_KILL: 'session:kill',
  SESSION_INPUT: 'session:input',
  SESSION_RESIZE: 'session:resize',
  SESSION_LIST: 'session:list',
  SESSION_RENAME: 'session:rename',
  SESSION_REMOVE: 'session:remove',
  ENV_LIST: 'environment:list',
  ENV_CREATE: 'environment:create',
  ENV_UPDATE: 'environment:update',
  ENV_DELETE: 'environment:delete',
  WORKSPACE_SAVE: 'workspace:save',
  WORKSPACE_LOAD: 'workspace:load',
  DIALOG_OPEN_DIRECTORY: 'dialog:open-directory',
  SCAN_REPOS_DIR: 'scan:repos-dir',
  CONFIG_GET: 'config:get',
  CONFIG_SET: 'config:set',
  CONFIG_GET_DEFAULT_ENV_VARS: 'config:get-default-env-vars',
  CONFIG_SET_DEFAULT_ENV_VARS: 'config:set-default-env-vars',

  // Main -> Renderer
  SESSION_DATA: 'session:data',
  SESSION_STATE_CHANGE: 'session:state-change',
  SESSION_EXITED: 'session:exited',
} as const;
