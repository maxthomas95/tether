import type { CliUpdateMethod, MaintainableCliTool } from './cli-tools';

export interface CliMaintenanceRequest {
  /** Chosen before subscribing/starting so fast PTY output cannot be lost. */
  id: string;
  tool: MaintainableCliTool;
  action: 'check' | 'update';
  method: CliUpdateMethod;
  environmentId?: string;
  workspace?: string;
  /** Optional existing session supplies its actual launch environment and directory. */
  sessionId?: string;
  cols?: number;
  rows?: number;
}

export interface CliMaintenanceRun {
  id: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  phase: 'locate' | 'before' | 'update' | 'after';
  exitCode?: number;
  error?: string;
}
