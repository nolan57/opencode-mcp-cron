import type { CronSchedule } from './types.js';
export declare function computeNextRunAtMs(schedule: CronSchedule, nowMs: number): number | undefined;
export declare function isJobDue(job: {
    schedule: CronSchedule;
    state: {
        nextRunAtMs?: number;
    };
}, nowMs: number): boolean;
export declare function formatNextRun(nextRunAtMs: number | null | undefined): string;
