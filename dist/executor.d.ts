import type { CronJob, CronJobResult } from './types.js';
export declare function executeJob(job: CronJob): Promise<CronJobResult>;
export declare function applyJobResult(job: CronJob, result: CronJobResult, nowMs: number): {
    shouldDelete: boolean;
    updates: Partial<CronJob>;
};
