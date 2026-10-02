import { createTrustedIpc } from './trusted-ipc';
import { IPC } from '../../shared/constants';
import { jobsService } from '../jobs/jobs-service';
import type { HandlerContext } from './helpers';
import type { JobsSettings } from '../../shared/types';
import { readJobsConfig, saveJobsConfig, disableJobsConfig } from '../jobs/jobs-config';

export function registerJobsHandlers(ctx: HandlerContext): void {
  const ipc = createTrustedIpc(ctx.mainWindow);
  ipc.handle(IPC.JOBS_GET_SETTINGS, () => readJobsConfig());
  ipc.handle(IPC.JOBS_SAVE_SETTINGS, (_event, settings: JobsSettings) => {
    saveJobsConfig(settings);
    return jobsService.refresh();
  });
  ipc.handle(IPC.JOBS_DISABLE, () => {
    disableJobsConfig();
    return jobsService.refresh();
  });
  ipc.handle(IPC.JOBS_REMOVE, () => {
    disableJobsConfig(true);
    return jobsService.refresh();
  });
  ipc.handle(IPC.JOBS_GET_STATUS, () => jobsService.getStatus());
  ipc.handle(IPC.JOBS_REFRESH, () => jobsService.refresh());

  jobsService.onStatusChange((status) => {
    ctx.send(IPC.JOBS_STATUS_UPDATED, status);
  });
}
