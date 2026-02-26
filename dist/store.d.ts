import type { CronJob } from './types.js';
export declare class CronStore {
    private storePath;
    private data;
    private lock;
    constructor(storePath?: string);
    private ensureDir;
    private load;
    private persist;
    acquireLock(): Promise<boolean>;
    releaseLock(): void;
    getJobs(includeDisabled?: boolean): CronJob[];
    getJob(id: string): CronJob | undefined;
    addJob(job: CronJob): CronJob;
    updateJob(id: string, updates: Partial<CronJob>): CronJob | undefined;
    removeJob(id: string): boolean;
    getNextWakeTime(): number | null;
    getStatus(): {
        jobs: number;
        nextWakeAtMs: number | null;
    };
}
export declare function getStore(path?: string): CronStore;
export declare function createJobId(): string;
