import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import type { CronJob, CronStore as CronStoreType } from './types.js';

const DEFAULT_STORE_PATH = join(process.env.HOME || '~', '.config', 'mcp-cron', 'jobs.json');

export class CronStore {
  private storePath: string;
  private data: CronStoreType;
  private lock: boolean = false;

  constructor(storePath?: string) {
    this.storePath = storePath || DEFAULT_STORE_PATH;
    this.ensureDir();
    this.data = this.load();
  }

  private ensureDir(): void {
    const dir = dirname(this.storePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  private load(): CronStoreType {
    try {
      if (existsSync(this.storePath)) {
        const data = readFileSync(this.storePath, 'utf-8');
        return JSON.parse(data);
      }
    } catch (error) {
      console.error('[CronStore] Load error:', error);
    }
    return { version: 1, jobs: [] };
  }

  private persist(): void {
    try {
      writeFileSync(this.storePath, JSON.stringify(this.data, null, 2));
    } catch (error) {
      console.error('[CronStore] Persist error:', error);
    }
  }

  async acquireLock(): Promise<boolean> {
    if (this.lock) return false;
    this.lock = true;
    return true;
  }

  releaseLock(): void {
    this.lock = false;
  }

  getJobs(includeDisabled: boolean = false): CronJob[] {
    if (includeDisabled) {
      return this.data.jobs;
    }
    return this.data.jobs.filter(job => job.enabled);
  }

  getJob(id: string): CronJob | undefined {
    return this.data.jobs.find(job => job.id === id);
  }

  addJob(job: CronJob): CronJob {
    this.data.jobs.push(job);
    this.persist();
    return job;
  }

  updateJob(id: string, updates: Partial<CronJob>): CronJob | undefined {
    const index = this.data.jobs.findIndex(job => job.id === id);
    if (index === -1) return undefined;
    
    this.data.jobs[index] = { ...this.data.jobs[index], ...updates };
    this.persist();
    return this.data.jobs[index];
  }

  removeJob(id: string): boolean {
    const index = this.data.jobs.findIndex(job => job.id === id);
    if (index === -1) return false;
    
    this.data.jobs.splice(index, 1);
    this.persist();
    return true;
  }

  getNextWakeTime(): number | null {
    const enabledJobs = this.getJobs(false);
    let nextTime: number | null = null;
    
    for (const job of enabledJobs) {
      if (job.state.nextRunAtMs) {
        if (nextTime === null || job.state.nextRunAtMs < nextTime) {
          nextTime = job.state.nextRunAtMs;
        }
      }
    }
    
    return nextTime;
  }

  getStatus(): { jobs: number; nextWakeAtMs: number | null } {
    return {
      jobs: this.data.jobs.length,
      nextWakeAtMs: this.getNextWakeTime()
    };
  }
}

let storeInstance: CronStore | null = null;

export function getStore(path?: string): CronStore {
  if (!storeInstance) {
    storeInstance = new CronStore(path);
  }
  return storeInstance;
}

export function createJobId(): string {
  return `job_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}
