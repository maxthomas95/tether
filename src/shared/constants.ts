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
  CODER_LIST_WORKSPACES: 'coder:list-workspaces',
  CODER_LIST_TEMPLATES: 'coder:list-templates',
  CODER_GET_TEMPLATE_PARAMS: 'coder:get-template-params',
  CODER_CREATE_WORKSPACE: 'coder:create-workspace',
  CODER_CREATE_PROGRESS: 'coder:create-progress',
  PROFILE_LIST: 'profile:list',
  PROFILE_CREATE: 'profile:create',
  PROFILE_UPDATE: 'profile:update',
  PROFILE_DELETE: 'profile:delete',
  WORKSPACE_SAVE: 'workspace:save',
  WORKSPACE_LOAD: 'workspace:load',
  TRANSCRIPTS_LIST: 'transcripts:list',
  DIALOG_OPEN_DIRECTORY: 'dialog:open-directory',
  SCAN_REPOS_DIR: 'scan:repos-dir',
  CONFIG_GET: 'config:get',
  CONFIG_SET: 'config:set',
  CONFIG_GET_DEFAULT_ENV_VARS: 'config:get-default-env-vars',
  CONFIG_SET_DEFAULT_ENV_VARS: 'config:set-default-env-vars',
  CONFIG_GET_DEFAULT_CLI_FLAGS: 'config:get-default-cli-flags',
  CONFIG_SET_DEFAULT_CLI_FLAGS: 'config:set-default-cli-flags',
  CONFIG_GET_DEFAULT_CLI_FLAGS_PER_TOOL: 'config:get-default-cli-flags-per-tool',
  CONFIG_SET_DEFAULT_CLI_FLAGS_FOR_TOOL: 'config:set-default-cli-flags-for-tool',

  REPOGROUP_GET_PREFS: 'repogroup:get-prefs',
  REPOGROUP_SET_PREFS: 'repogroup:set-prefs',

  TITLEBAR_UPDATE: 'titlebar:update',

  // Git provider & clone
  GIT_PROVIDER_LIST: 'git:provider-list',
  GIT_PROVIDER_CREATE: 'git:provider-create',
  GIT_PROVIDER_UPDATE: 'git:provider-update',
  GIT_PROVIDER_DELETE: 'git:provider-delete',
  GIT_PROVIDER_TEST: 'git:provider-test',
  GIT_PROVIDER_REPOS: 'git:provider-repos',
  GIT_CLONE: 'git:clone',
  GIT_INIT: 'git:init',

  // Vault
  VAULT_GET_CONFIG: 'vault:get-config',
  VAULT_SET_CONFIG: 'vault:set-config',
  VAULT_LOGIN: 'vault:login',
  VAULT_LOGOUT: 'vault:logout',
  VAULT_STATUS: 'vault:status',
  VAULT_TEST_REF: 'vault:test-ref',
  VAULT_LIST_KEYS: 'vault:list-keys',
  VAULT_MIGRATE_SECRET: 'vault:migrate-secret',
  VAULT_LIST_PLAINTEXT: 'vault:list-plaintext',
  VAULT_WRITE_SECRET: 'vault:write-secret',

  // Docs
  DOCS_OPEN: 'docs:open',
  DOCS_THEME_CHANGED: 'docs:theme-changed',

  // Quota
  QUOTA_GET: 'quota:get',
  QUOTA_REFRESH: 'quota:refresh',
  QUOTA_SET_ENABLED: 'quota:set-enabled',

  // Usage
  USAGE_GET_SESSION: 'usage:get-session',
  USAGE_GET_ALL: 'usage:get-all',
  USAGE_REFRESH: 'usage:refresh',

  // Update
  UPDATE_CHECK: 'update:check',
  UPDATE_OPEN_RELEASE_PAGE: 'update:open-release',

  // SSH known hosts
  SSH_HOST_VERIFY_REQUEST: 'ssh:host-verify-request',
  SSH_HOST_VERIFY_RESPONSE: 'ssh:host-verify-response',
  KNOWN_HOSTS_LIST: 'known-hosts:list',
  KNOWN_HOSTS_DELETE: 'known-hosts:delete',

  // Main -> Renderer
  USAGE_UPDATED: 'usage:updated',
  QUOTA_UPDATED: 'quota:updated',
  UPDATE_AVAILABLE: 'update:available',
  SESSION_DATA: 'session:data',
  SESSION_STATE_CHANGE: 'session:state-change',
  SESSION_EXITED: 'session:exited',
  SESSION_UPDATED: 'session:updated',
  GIT_CLONE_PROGRESS: 'git:clone-progress',
  VAULT_STATUS_CHANGED: 'vault:status-changed',
} as const;
