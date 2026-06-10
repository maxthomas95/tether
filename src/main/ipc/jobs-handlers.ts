import { ipcMain } from 'electron';
import { IPC } from '../../shared/constants';
import { jobsService } from '../jobs/jobs-service';
import type { HandlerContext } from './helpers';

export function registerJobsHandlers(ctx: HandlerContext): void {
  ipcMain.handle(IPC.JOBS_GET_STATUS, () => jobsService.getStatus());
  ipcMain.handle(IPC.JOBS_REFRESH, () => jobsService.refresh());

  jobsService.onStatusChange((status) => {
    ctx.send(IPC.JOBS_STATUS_UPDATED, status);
  });
}
