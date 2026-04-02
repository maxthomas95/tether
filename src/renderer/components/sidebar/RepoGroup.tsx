import { useState } from 'react';
import { SessionItem } from './SessionItem';
import type { SessionInfo } from '../../../shared/types';

interface RepoGroupProps {
  repoPath: string;
  sessions: SessionInfo[];
  activeSessionId: string | null;
  onSelectSession: (id: string) => void;
  onStop: (id: string) => void;
  onKill: (id: string) => void;
  onRename: (id: string, label: string) => void;
  onRemove: (id: string) => void;
}

export function RepoGroup({
  repoPath,
  sessions,
  activeSessionId,
  onSelectSession,
  onStop,
  onKill,
  onRename,
  onRemove,
}: RepoGroupProps) {
  const [collapsed, setCollapsed] = useState(false);

  // Only show repo grouping when there are 2+ sessions in same dir
  if (sessions.length === 1) {
    return (
      <SessionItem
        session={sessions[0]}
        isActive={sessions[0].id === activeSessionId}
        onClick={() => onSelectSession(sessions[0].id)}
        onStop={() => onStop(sessions[0].id)}
        onKill={() => onKill(sessions[0].id)}
        onRename={(label) => onRename(sessions[0].id, label)}
        onRemove={() => onRemove(sessions[0].id)}
      />
    );
  }

  const runningCount = sessions.filter(
    s => s.state === 'running' || s.state === 'waiting',
  ).length;

  const dirName = repoPath.split(/[\\/]/).pop() || repoPath;

  return (
    <div className="repo-group">
      <div
        className="repo-group-header"
        onClick={() => setCollapsed(c => !c)}
      >
        <span className="repo-group-chevron">
          {collapsed ? '\u25b8' : '\u25be'}
        </span>
        <span className="repo-group-name">{dirName}</span>
        <span className="repo-group-count">
          {sessions.length}
          {runningCount > 0 && (
            <span className="repo-group-active"> / {runningCount} active</span>
          )}
        </span>
      </div>
      {!collapsed && sessions.map(session => (
        <SessionItem
          key={session.id}
          session={session}
          isActive={session.id === activeSessionId}
          onClick={() => onSelectSession(session.id)}
          onStop={() => onStop(session.id)}
          onKill={() => onKill(session.id)}
          onRename={(label) => onRename(session.id, label)}
          onRemove={() => onRemove(session.id)}
          nested
        />
      ))}
    </div>
  );
}
