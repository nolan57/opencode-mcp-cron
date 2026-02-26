import type { CronJob, CronJobCreate, CronJobPatch } from './types.js';
declare class CronScheduler {
    private timer;
    private running;
    private store;
    start(): void;
    stop(): void;
    private tick;
    private executeJob;
    addJob(input: CronJobCreate): CronJob;
    updateJob(id: string, patch: CronJobPatch): CronJob | undefined;
    removeJob(id: string): boolean;
    listJobs(includeDisabled?: boolean): CronJob[];
    getJob(id: string): CronJob | undefined;
    getStatus(): {
        jobs: number;
        nextWakeAtMs: number | null;
        enabled: boolean;
    };
    runJobNow(id: string, force?: boolean): Promise<{
        success: boolean;
        error?: string;
    }>;
}
export declare function getScheduler(): CronScheduler;
export {};
