import { spawn } from 'child_process';
import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import type { CronJob, CronJobResult, CronJobState } from './types.js';
import { computeNextRunAtMs } from './schedule.js';

const OPENCODE_COMMAND = process.env.OPENCODE_COMMAND || 'opencode';
const LOG_DIR = join(process.env.HOME || '~', '.local', 'share', 'mcp-cron', 'logs');

const ERROR_BACKOFF_MS = [
  30_000,   // 1st error → 30s
  60_000,   // 2nd error → 1m
  300_000,  // 3rd error → 5m
  900_000,  // 4th error → 15m
  3600_000  // 5th+ error → 60m
];

function ensureLogDir(): void {
  if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true });
  }
}

export async function executeJob(job: CronJob): Promise<CronJobResult> {
  const startTime = Date.now();
  const logFile = join(LOG_DIR, `${job.id}.log`);
  
  ensureLogDir();
  
  try {
    console.log(`[Executor] Executing job: ${job.name} (${job.id})`);
    
    if (job.payload.kind === 'systemEvent') {
      const result = await executeSystemEvent(job, logFile);
      return result;
    }
    
    if (job.payload.kind === 'agentTurn') {
      const result = await executeAgentTurn(job, logFile);
      return result;
    }
    
    return {
      status: 'error',
      error: 'Unknown payload kind'
    };
    
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[Executor] Job ${job.id} failed:`, errorMsg);
    
    return {
      status: 'error',
      error: errorMsg,
      durationMs: Date.now() - startTime
    };
  }
}

async function executeAgentTurn(job: CronJob, logFile: string): Promise<CronJobResult> {
  const startTime = Date.now();
  const message = job.payload.message;
  
  return new Promise((resolve) => {
    const args = ['run', message];
    
    const proc = spawn(OPENCODE_COMMAND, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env }
    });
    
    let stdout = '';
    let stderr = '';
    
    proc.stdout?.on('data', (data) => {
      stdout += data.toString();
    });
    
    proc.stderr?.on('data', (data) => {
      stderr += data.toString();
    });
    
    proc.on('close', (code) => {
      const durationMs = Date.now() - startTime;
      const fullOutput = stdout + stderr;
      
      writeFileSync(logFile, fullOutput);
      
      if (code === 0) {
        resolve({
          status: 'ok',
          output: stdout.substring(0, 1000),
          durationMs
        });
      } else {
        resolve({
          status: 'error',
          error: stderr.substring(0, 500) || `Exit code: ${code}`,
          output: fullOutput.substring(0, 1000),
          durationMs
        });
      }
    });
    
    proc.on('error', (err) => {
      resolve({
        status: 'error',
        error: err.message,
        durationMs: Date.now() - startTime
      });
    });
    
    setTimeout(() => {
      proc.kill('SIGTERM');
      resolve({
        status: 'error',
        error: 'Timeout',
        durationMs: Date.now() - startTime
      });
    }, 300000);
  });
}

async function executeSystemEvent(job: CronJob, logFile: string): Promise<CronJobResult> {
  return {
    status: 'ok',
    output: job.payload.message,
    durationMs: 0
  };
}

export function applyJobResult(
  job: CronJob, 
  result: CronJobResult, 
  nowMs: number
): { shouldDelete: boolean; updates: Partial<CronJob> } {
  const updates: Partial<CronJob> = {
    state: { ...job.state }
  };
  
  updates.state!.runningAtMs = undefined;
  updates.state!.lastRunAtMs = nowMs;
  updates.state!.lastStatus = result.status;
  updates.state!.lastDurationMs = result.durationMs;
  updates.state!.lastError = result.error;
  
  if (result.status === 'error') {
    updates.state!.consecutiveErrors = (updates.state!.consecutiveErrors || 0) + 1;
  } else {
    updates.state!.consecutiveErrors = 0;
  }
  
  const shouldDelete = job.options?.deleteAfterRun && result.status === 'ok';
  
  if (shouldDelete) {
    return { shouldDelete: true, updates };
  }
  
  if (job.schedule.kind === 'at') {
    updates.enabled = false;
    updates.state!.nextRunAtMs = undefined;
  } else if (result.status === 'error' && job.enabled) {
    const idx = Math.min(
      (updates.state!.consecutiveErrors || 1) - 1, 
      ERROR_BACKOFF_MS.length - 1
    );
    const backoffMs = ERROR_BACKOFF_MS[Math.max(0, idx)];
    const normalNext = computeNextRunAtMs(job.schedule, nowMs);
    updates.state!.nextRunAtMs = normalNext 
      ? Math.max(normalNext, nowMs + backoffMs)
      : nowMs + backoffMs;
  } else if (job.enabled) {
    updates.state!.nextRunAtMs = computeNextRunAtMs(job.schedule, nowMs);
  } else {
    updates.state!.nextRunAtMs = undefined;
  }
  
  return { shouldDelete: false, updates };
}
