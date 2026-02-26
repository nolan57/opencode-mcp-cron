export type CronSchedule = {
    kind: 'at';
    atMs: number;
} | {
    kind: 'every';
    everyMs: number;
    anchorMs?: number;
} | {
    kind: 'cron';
    expr: string;
    tz?: string;
};
export type CronPayloadKind = 'agentTurn' | 'systemEvent';
export type CronPayload = {
    kind: CronPayloadKind;
    message: string;
    deliver?: boolean;
    channel?: string;
    to?: string;
    model?: string;
};
export type CronJobOptions = {
    deleteAfterRun?: boolean;
    retry?: boolean;
    maxRetries?: number;
};
export type CronRunStatus = 'ok' | 'error' | 'skipped';
export type CronJobState = {
    nextRunAtMs?: number;
    runningAtMs?: number;
    lastRunAtMs?: number;
    lastStatus?: CronRunStatus;
    lastError?: string;
    lastDurationMs?: number;
    consecutiveErrors?: number;
};
export type CronJob = {
    id: string;
    name: string;
    description?: string;
    enabled: boolean;
    createdAtMs: number;
    updatedAtMs: number;
    schedule: CronSchedule;
    payload: CronPayload;
    options?: CronJobOptions;
    state: CronJobState;
};
export type CronJobCreate = Omit<CronJob, 'id' | 'createdAtMs' | 'updatedAtMs' | 'state'> & {
    state?: Partial<CronJobState>;
};
export type CronJobPatch = Partial<Omit<CronJob, 'id' | 'createdAtMs' | 'state'>>;
export type CronStore = {
    version: 1;
    jobs: CronJob[];
};
export type CronJobResult = {
    status: CronRunStatus;
    error?: string;
    output?: string;
    durationMs?: number;
};
export type CronStatus = {
    enabled: boolean;
    jobs: number;
    nextWakeAtMs: number | null;
    running: boolean;
};
