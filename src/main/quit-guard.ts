export function countSessionsInFlight(sessions: Array<{ state: string; waitingReason?: string }>): number {
  return sessions.filter(session =>
    session.state === 'starting'
    || session.state === 'running'
    || (session.state === 'waiting' && session.waitingReason === 'permission'),
  ).length;
}

export function shouldConfirmQuit(opts: { configValue: string | undefined; inFlight: number; alreadyConfirmed: boolean }): boolean {
  return opts.configValue !== 'false' && opts.inFlight > 0 && !opts.alreadyConfirmed;
}
