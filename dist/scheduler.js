import { getStore, createJobId } from './store.js';
import { computeNextRunAtMs, isJobDue } from './schedule.js';
import { executeJob, applyJobResult } from './executor.js';
const CHECK_INTERVAL_MS = 60000;
const MAX_CONCURRENT = 3;
class CronScheduler {
    timer = null;
    running = false;
    store = getStore();
    start() {
        if (this.running)
            return;
        console.log('[Scheduler] Starting...');
        this.running = true;
        this.tick();
        this.timer = setInterval(() => this.tick(), CHECK_INTERVAL_MS);
    }
    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        this.running = false;
        console.log('[Scheduler] Stopped');
    }
    async tick() {
        const nowMs = Date.now();
        const jobs = this.store.getJobs(false);
        const dueJobs = jobs.filter(job => isJobDue(job, nowMs));
        if (dueJobs.length === 0)
            return;
        console.log(`[Scheduler] ${dueJobs.length} jobs due`);
        const toExecute = dueJobs.slice(0, MAX_CONCURRENT);
        for (const job of toExecute) {
            this.executeJob(job);
        }
    }
    async executeJob(job) {
        const lock = await this.store.acquireLock();
        if (!lock)
            return;
        try {
            const updatedJob = this.store.getJob(job.id);
            if (!updatedJob || !updatedJob.enabled)
                return;
            this.store.updateJob(job.id, {
                state: { ...updatedJob.state, runningAtMs: Date.now() }
            });
            const result = await executeJob(updatedJob);
            const { shouldDelete, updates } = applyJobResult(updatedJob, result, Date.now());
            if (shouldDelete) {
                this.store.removeJob(job.id);
                console.log(`[Scheduler] Job ${job.id} deleted (one-shot)`);
            }
            else {
                this.store.updateJob(job.id, updates);
            }
            console.log(`[Scheduler] Job ${job.id} completed: ${result.status}`);
        }
        catch (error) {
            console.error(`[Scheduler] Job ${job.id} error:`, error);
        }
        finally {
            this.store.releaseLock();
        }
    }
    addJob(input) {
        const nowMs = Date.now();
        const job = {
            ...input,
            id: createJobId(),
            enabled: true,
            createdAtMs: nowMs,
            updatedAtMs: nowMs,
            state: {
                ...input.state,
                nextRunAtMs: computeNextRunAtMs(input.schedule, nowMs)
            }
        };
        this.store.addJob(job);
        console.log(`[Scheduler] Job added: ${job.name} (${job.id})`);
        return job;
    }
    updateJob(id, patch) {
        const job = this.store.getJob(id);
        if (!job)
            return undefined;
        const updates = { ...patch, updatedAtMs: Date.now() };
        if (patch.schedule) {
            updates.state = {
                ...job.state,
                nextRunAtMs: computeNextRunAtMs(patch.schedule, Date.now())
            };
        }
        return this.store.updateJob(id, updates);
    }
    removeJob(id) {
        return this.store.removeJob(id);
    }
    listJobs(includeDisabled = false) {
        return this.store.getJobs(includeDisabled);
    }
    getJob(id) {
        return this.store.getJob(id);
    }
    getStatus() {
        return {
            enabled: this.running,
            ...this.store.getStatus()
        };
    }
    async runJobNow(id, force = true) {
        const job = this.store.getJob(id);
        if (!job) {
            return { success: false, error: 'Job not found' };
        }
        try {
            const result = await executeJob(job);
            const { shouldDelete, updates } = applyJobResult(job, result, Date.now());
            if (shouldDelete) {
                this.store.removeJob(id);
            }
            else {
                this.store.updateJob(id, updates);
            }
            return { success: result.status === 'ok', error: result.error };
        }
        catch (error) {
            return { success: false, error: String(error) };
        }
    }
}
let schedulerInstance = null;
export function getScheduler() {
    if (!schedulerInstance) {
        schedulerInstance = new CronScheduler();
    }
    return schedulerInstance;
}
