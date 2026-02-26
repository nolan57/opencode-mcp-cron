import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
const DEFAULT_STORE_PATH = join(process.env.HOME || '~', '.config', 'mcp-cron', 'jobs.json');
export class CronStore {
    storePath;
    data;
    lock = false;
    constructor(storePath) {
        this.storePath = storePath || DEFAULT_STORE_PATH;
        this.ensureDir();
        this.data = this.load();
    }
    ensureDir() {
        const dir = dirname(this.storePath);
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }
    }
    load() {
        try {
            if (existsSync(this.storePath)) {
                const data = readFileSync(this.storePath, 'utf-8');
                return JSON.parse(data);
            }
        }
        catch (error) {
            console.error('[CronStore] Load error:', error);
        }
        return { version: 1, jobs: [] };
    }
    persist() {
        try {
            writeFileSync(this.storePath, JSON.stringify(this.data, null, 2));
        }
        catch (error) {
            console.error('[CronStore] Persist error:', error);
        }
    }
    async acquireLock() {
        if (this.lock)
            return false;
        this.lock = true;
        return true;
    }
    releaseLock() {
        this.lock = false;
    }
    getJobs(includeDisabled = false) {
        if (includeDisabled) {
            return this.data.jobs;
        }
        return this.data.jobs.filter(job => job.enabled);
    }
    getJob(id) {
        return this.data.jobs.find(job => job.id === id);
    }
    addJob(job) {
        this.data.jobs.push(job);
        this.persist();
        return job;
    }
    updateJob(id, updates) {
        const index = this.data.jobs.findIndex(job => job.id === id);
        if (index === -1)
            return undefined;
        this.data.jobs[index] = { ...this.data.jobs[index], ...updates };
        this.persist();
        return this.data.jobs[index];
    }
    removeJob(id) {
        const index = this.data.jobs.findIndex(job => job.id === id);
        if (index === -1)
            return false;
        this.data.jobs.splice(index, 1);
        this.persist();
        return true;
    }
    getNextWakeTime() {
        const enabledJobs = this.getJobs(false);
        let nextTime = null;
        for (const job of enabledJobs) {
            if (job.state.nextRunAtMs) {
                if (nextTime === null || job.state.nextRunAtMs < nextTime) {
                    nextTime = job.state.nextRunAtMs;
                }
            }
        }
        return nextTime;
    }
    getStatus() {
        return {
            jobs: this.data.jobs.length,
            nextWakeAtMs: this.getNextWakeTime()
        };
    }
}
let storeInstance = null;
export function getStore(path) {
    if (!storeInstance) {
        storeInstance = new CronStore(path);
    }
    return storeInstance;
}
export function createJobId() {
    return `job_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}
