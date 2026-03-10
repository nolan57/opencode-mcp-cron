/**
 * MCP Cron Server - 调度控制器
 * 
 * 负责：
 * - 动态休眠调度（基于下次执行时间计算）
 * - 分批限流（防止惊群效应）
 * - 递归 setTimeout（防止调度循环重叠）
 * - 状态机驱动的任务调度
 * - 并发执行控制
 * - 失败重试策略
 * - 僵尸任务检测
 * 
 * @module scheduler
 */

import type {
  CronJob,
  CronJobCreate,
  CronJobPatch,
  ExecutionStatus,
  SchedulerStatus,
  Execution,
} from './types.js';
import { getRepository, type Repository } from './repository.js';
import { computeNextRunAtMs } from './schedule.js';
import { executeJob, applyJobResult, detectStaleExecutions, getActiveExecutionCount } from './executor.js';

// ============================================================================
// 配置常量
// ============================================================================

/** 最大并发执行数（同时运行的任务数） */
const MAX_CONCURRENT: number = 3;

/** 每批次最大处理任务数（防止惊群效应） */
const MAX_BATCH_SIZE: number = 10;

/** 最大休眠时间（60秒） */
const MAX_SLEEP_MS: number = 60_000;

/** 最小休眠时间（1秒） */
const MIN_SLEEP_MS: number = 1000;

/** 有积压任务时的快速轮询间隔（1秒） */
const BACKLOG_POLL_MS: number = 1000;

/** 僵尸任务检测间隔（5分钟） */
const STALE_CHECK_INTERVAL_MS: number = 5 * 60 * 1000;

/** 僵尸任务判定阈值（5分钟无心跳） */
const STALE_THRESHOLD_MS: number = 5 * 60 * 1000;

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 到期任务查询结果（包含批次和总数）
 */
interface DueJobsResult {
  /** 本批次待处理的任务 */
  batch: CronJob[];
  /** 到期任务总数 */
  totalDue: number;
  /** 是否有剩余任务 */
  hasRemaining: boolean;
}

// ============================================================================
// 调度器类
// ============================================================================

/**
 * 调度控制器
 * 
 * 使用递归 setTimeout + 分批限流保证稳定性：
 * 1. 每次 tick 完全结束后才调度下一次，防止循环重叠
 * 2. 每批最多处理 MAX_BATCH_SIZE 个任务，防止惊群效应
 * 3. 动态休眠算法优化调度效率
 */
class CronScheduler {
  /** 主调度定时器 */
  private loopTimer: ReturnType<typeof setTimeout> | null = null;

  /** 僵尸检测定时器 */
  private staleCheckTimer: ReturnType<typeof setInterval> | null = null;

  /** 是否已停止 */
  private stopped: boolean = true;

  /** 启动时间 */
  private startedAt: number | null = null;

  /** 上次 tick 开始时间 */
  private lastTickAt: number | null = null;

  /** 上次 tick 结束时间 */
  private lastTickEndAt: number | null = null;

  /** 数据仓库 */
  private repo: Repository;

  /** 正在处理的任务数 */
  private processingCount: number = 0;

  /** 是否正在执行 tick（防止重入） */
  private isTicking: boolean = false;

  constructor() {
    this.repo = getRepository();
  }

  // =========================================================================
  // 生命周期
  // =========================================================================

  /**
   * 启动调度器
   */
  start(): void {
    if (!this.stopped) {
      console.error('[Scheduler] Already running');
      return;
    }

    console.error('[Scheduler] Starting...');
    this.stopped = false;
    this.startedAt = Date.now();

    // 启动僵尸任务检测
    this.startStaleCheck();

    // 启动调度循环（递归 setTimeout 模式）
    this.scheduleNextLoop();
  }

  /**
   * 停止调度器
   */
  stop(): void {
    if (this.stopped) return;

    console.error('[Scheduler] Stopping...');

    this.stopped = true;

    // 停止主调度定时器
    if (this.loopTimer) {
      clearTimeout(this.loopTimer);
      this.loopTimer = null;
    }

    // 停止僵尸检测
    if (this.staleCheckTimer) {
      clearInterval(this.staleCheckTimer);
      this.staleCheckTimer = null;
    }

    console.error('[Scheduler] Stopped');
  }

  /**
   * 启动僵尸任务检测
   */
  private startStaleCheck(): void {
    this.staleCheckTimer = setInterval(() => {
      try {
        const markedCount = detectStaleExecutions(STALE_THRESHOLD_MS);
        if (markedCount > 0) {
          console.error(`[Scheduler] Marked ${markedCount} stale executions as failed`);
        }
      } catch (error) {
        console.error('[Scheduler] Stale check failed:', error);
      }
    }, STALE_CHECK_INTERVAL_MS);

    // 不阻止进程退出
    if (this.staleCheckTimer.unref) {
      this.staleCheckTimer.unref();
    }
  }

  // =========================================================================
  // 递归 setTimeout 调度（防止循环重叠）
  // =========================================================================

  /**
   * 调度下一次循环
   * 
   * 递归 setTimeout 模式：
   * - 确保当前循环完全结束后才调度下一次
   * - 防止多个 runLoop 实例并发运行
   * - 错误不会中断调度链
   */
  private scheduleNextLoop(): void {
    if (this.stopped) return;

    const delay = this.calculateNextDelay();

    this.loopTimer = setTimeout(() => {
      this.executeLoop();
    }, delay);

    // 不阻止进程退出
    if (this.loopTimer.unref) {
      this.loopTimer.unref();
    }
  }

  /**
   * 执行调度循环
   * 
   * 确保串行化执行：
   * - await 当前循环完成
   * - 在 finally 中调度下一次
   */
  private async executeLoop(): Promise<void> {
    // 防止重入
    if (this.isTicking) {
      console.error('[Scheduler] Loop overlap detected, skipping (previous tick still running)');
      this.scheduleNextLoop();
      return;
    }

    this.isTicking = true;
    this.lastTickAt = Date.now();

    try {
      await this.runLoop();
    } catch (error) {
      console.error('[Scheduler] Critical loop error:', error);
    } finally {
      this.isTicking = false;
      this.lastTickEndAt = Date.now();

      // 只有当前循环结束后，才预约下一次
      if (!this.stopped) {
        this.scheduleNextLoop();
      }
    }
  }

  /**
   * 计算下次调度延迟
   * 
   * 动态休眠算法：
   * - 有积压任务时使用快速轮询（1秒）
   * - 否则根据下次唤醒时间计算
   */
  private calculateNextDelay(): number {
    const nowMs = Date.now();

    // 获取下一个唤醒时间
    const nextWakeTime = this.repo.getNextWakeTime();

    if (nextWakeTime === null) {
      // 没有待执行任务，使用最大休眠时间
      return MAX_SLEEP_MS;
    }

    const delay = nextWakeTime - nowMs;

    if (delay <= 0) {
      // 已有过期任务，使用快速轮询
      return BACKLOG_POLL_MS;
    }

    // 限制最大休眠时间
    return Math.min(delay, MAX_SLEEP_MS);
  }

  // =========================================================================
  // 主调度逻辑（分批限流）
  // =========================================================================

  /**
   * 主调度循环
   * 
   * 分批限流：
   * - 每次最多处理 MAX_BATCH_SIZE 个任务
   * - 剩余任务在下一个调度周期处理
   */
  private async runLoop(): Promise<void> {
    if (this.stopped) return;

    // 检查并发限制
    const activeCount = getActiveExecutionCount();
    const availableSlots = MAX_CONCURRENT - this.processingCount - activeCount;

    if (availableSlots <= 0) {
      console.error('[Scheduler] Max concurrent reached, skipping tick');
      return;
    }

    // 获取到期的任务（分批限流）
    const dueResult = this.getDueJobsWithLimit(availableSlots);

    if (dueResult.batch.length === 0) {
      // 没有到期任务
      return;
    }

    // 记录限流日志
    if (dueResult.hasRemaining) {
      const remaining = dueResult.totalDue - dueResult.batch.length;
      console.error(
        `[Scheduler] ${dueResult.totalDue} tasks due, processing batch of ${dueResult.batch.length}. ` +
        `Remaining ${remaining} will be processed in next cycle.`
      );
    } else {
      console.error(`[Scheduler] Processing ${dueResult.batch.length} due tasks`);
    }

    // 并发执行任务
    for (const job of dueResult.batch) {
      this.executeJobAsync(job);
    }
  }

  /**
   * 获取到期的任务（带分批限流）
   * 
   * 状态机驱动：
   * - 仅查询 status='pending' 且 next_run_at <= now 的任务
   * - 跳过 waiting_for_approval 或 paused 状态的任务
   * - 分批限流：最多返回 MAX_BATCH_SIZE 个
   */
  private getDueJobsWithLimit(availableSlots: number): DueJobsResult {
    const nowMs = Date.now();
    const enabledJobs = this.repo.listEnabledJobs();

    // 过滤到期任务
    const dueJobs = enabledJobs.filter(job => {
      // 检查是否有执行时间
      if (!job.state?.nextRunAtMs) return false;

      // 检查是否到期
      return job.state.nextRunAtMs <= nowMs;
    });

    // 按执行时间排序
    dueJobs.sort((a, b) => {
      const aTime = a.state?.nextRunAtMs ?? Infinity;
      const bTime = b.state?.nextRunAtMs ?? Infinity;
      return aTime - bTime;
    });

    const totalDue = dueJobs.length;

    // 应用双层限制：并发槽位 + 批次大小
    const effectiveLimit = Math.min(availableSlots, MAX_BATCH_SIZE);
    const batch = dueJobs.slice(0, effectiveLimit);

    return {
      batch,
      totalDue,
      hasRemaining: dueJobs.length > effectiveLimit,
    };
  }

  // =========================================================================
  // 任务执行
  // =========================================================================

  /**
   * 异步执行任务（不阻塞调度循环）
   */
  private async executeJobAsync(job: CronJob): Promise<void> {
    this.processingCount++;

    try {
      // 检查是否需要审批
      if (job.options?.requiresApproval || job.config?.requiresApproval) {
        await this.handleApprovalRequired(job);
        return;
      }

      // 执行任务
      const result = await executeJob(job);

      // 应用结果
      const { shouldDelete, updates } = applyJobResult(job, result, Date.now());

      if (shouldDelete) {
        this.repo.deleteJob(job.id);
        console.error(`[Scheduler] Job ${job.id} deleted (one-shot completed)`);
      } else {
        // 更新任务状态和下次执行时间
        this.repo.updateJob(job.id, {
          ...updates,
          state: {
            ...job.state,
            ...updates.state,
            lastRunAtMs: Date.now(),
            lastStatus: result.status === 'success' ? 'ok' : 'error',
            lastError: result.error,
            lastDurationMs: result.durationMs,
          },
        });

        // 更新 next_run_at
        if (updates.state?.nextRunAtMs) {
          this.repo.updateJobNextRun(job.id, updates.state.nextRunAtMs);
        }
      }

      console.error(`[Scheduler] Job ${job.id} completed: ${result.status}`);

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[Scheduler] Job ${job.id} execution error:`, errorMsg);

      // 记录错误并计算重试时间
      this.handleExecutionError(job, errorMsg);

    } finally {
      this.processingCount--;
    }
  }

  /**
   * 处理需要审批的任务
   */
  private async handleApprovalRequired(job: CronJob): Promise<void> {
    // 创建执行记录
    const execution = this.repo.createExecution({
      jobId: job.id,
    });

    // 创建审批请求
    this.repo.createApproval({
      executionId: execution.id,
      requestMessage: `Task "${job.name}" requires approval before execution`,
      requestContextJson: JSON.stringify({
        jobName: job.name,
        jobDescription: job.description,
        schedule: job.schedule,
        payload: job.payload,
      }),
    });

    // 更新执行状态为等待审批
    this.repo.transitionExecutionStatus(
      execution.id,
      'pending',
      'waiting_for_approval',
      {}
    );

    // 更新任务下次执行时间
    const nextRun = computeNextRunAtMs(job.schedule, Date.now());
    this.repo.updateJobNextRun(job.id, nextRun ?? null);

    console.error(`[Scheduler] Job ${job.id} waiting for approval (execution: ${execution.id})`);
  }

  /**
   * 处理执行错误
   */
  private handleExecutionError(job: CronJob, errorMsg: string): void {
    const consecutiveErrors = (job.state?.consecutiveErrors ?? 0) + 1;

    // 更新任务状态
    this.repo.updateJob(job.id, {
      state: {
        ...job.state,
        consecutiveErrors,
        lastError: errorMsg,
        lastStatus: 'error',
      },
    });

    // 计算重试时间
    const nowMs = Date.now();
    const normalNext = computeNextRunAtMs(job.schedule, nowMs);

    // 使用错误退避策略
    const { getErrorBackoffMs } = require('./types.js') as typeof import('./types.js');
    const backoffMs = getErrorBackoffMs(consecutiveErrors);

    const nextRunMs = normalNext
      ? Math.max(normalNext, nowMs + backoffMs)
      : nowMs + backoffMs;

    this.repo.updateJobNextRun(job.id, nextRunMs);

    console.error(`[Scheduler] Job ${job.id} error #${consecutiveErrors}, next retry in ${backoffMs / 1000}s`);
  }

  // =========================================================================
  // 任务管理 API
  // =========================================================================

  /**
   * 添加任务
   */
  addJob(input: CronJobCreate): CronJob {
    const nowMs = Date.now();

    const job = this.repo.createJob({
      ...input,
      enabled: input.enabled ?? true,
    });

    // 计算并设置首次执行时间
    const nextRunMs = computeNextRunAtMs(input.schedule, nowMs);
    if (nextRunMs) {
      this.repo.updateJobNextRun(job.id, nextRunMs);
      job.state = { ...job.state, nextRunAtMs: nextRunMs };
    }

    console.error(`[Scheduler] Job added: ${job.name} (${job.id})`);

    // 触发立即调度检查
    if (this.loopTimer) {
      clearTimeout(this.loopTimer);
      this.loopTimer = null;
    }
    this.scheduleNextLoop();

    return job;
  }

  /**
   * 更新任务
   */
  updateJob(id: string, patch: CronJobPatch): CronJob | null {
    const existing = this.repo.getJob(id);
    if (!existing) return null;

    const updated = this.repo.updateJob(id, patch);

    // 如果更新了调度配置，重新计算下次执行时间
    if (patch.schedule && updated) {
      const nextRunMs = computeNextRunAtMs(patch.schedule, Date.now());
      this.repo.updateJobNextRun(id, nextRunMs ?? null);
      updated.state = { ...updated.state, nextRunAtMs: nextRunMs };
    }

    console.error(`[Scheduler] Job updated: ${id}`);
    return updated;
  }

  /**
   * 删除任务
   */
  removeJob(id: string): boolean {
    const result = this.repo.deleteJob(id);
    if (result) {
      console.error(`[Scheduler] Job removed: ${id}`);
    }
    return result;
  }

  /**
   * 列出所有任务
   */
  listJobs(includeInactive: boolean = false): CronJob[] {
    return this.repo.listJobs(!includeInactive);
  }

  /**
   * 获取单个任务
   */
  getJob(id: string): CronJob | null {
    return this.repo.getJob(id);
  }

  /**
   * 获取调度器状态
   */
  getStatus(): SchedulerStatus {
    const stats = this.repo.getSystemStats();

    return {
      enabled: !this.stopped,
      jobs: stats.activeJobs,
      nextWakeAtMs: this.repo.getNextWakeTime(),
      running: !this.stopped,
      activeExecutions: getActiveExecutionCount(),
      pendingApprovals: stats.pendingApprovals,
      lastTickAt: this.lastTickEndAt,
      uptimeMs: this.startedAt ? Date.now() - this.startedAt : 0,
    };
  }

  /**
   * 立即执行任务
   */
  async runJobNow(id: string): Promise<{ success: boolean; error?: string; executionId?: string }> {
    const job = this.repo.getJob(id);
    if (!job) {
      return { success: false, error: 'Job not found' };
    }

    try {
      const result = await executeJob(job);

      // 应用结果
      const { shouldDelete, updates } = applyJobResult(job, result, Date.now());

      if (shouldDelete) {
        this.repo.deleteJob(id);
      } else {
        this.repo.updateJob(id, updates);
      }

      return {
        success: result.status === 'success',
        error: result.error,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { success: false, error: errorMsg };
    }
  }

  // =========================================================================
  // 审批管理
  // =========================================================================

  /**
   * 获取待审批列表
   */
  getPendingApprovals(): Array<{ approvalId: string; executionId: string; jobId: string; jobName: string; requestMessage: string | null; createdAt: number }> {
    const approvals = this.repo.listPendingApprovals();
    return approvals.map(a => ({
      approvalId: a.id,
      executionId: a.executionId,
      jobId: a.jobId,
      jobName: a.jobName,
      requestMessage: a.requestMessage,
      createdAt: a.createdAt,
    }));
  }

  /**
   * 批准执行
   */
  approveExecution(executionId: string, note?: string): { success: boolean; error?: string } {
    const result = this.repo.approveExecution(executionId, note);
    if (!result) {
      return { success: false, error: 'Approval not found or already resolved' };
    }

    console.error(`[Scheduler] Execution ${executionId} approved`);

    // 触发立即调度检查
    if (this.loopTimer) {
      clearTimeout(this.loopTimer);
      this.loopTimer = null;
    }
    this.scheduleNextLoop();

    return { success: true };
  }

  /**
   * 拒绝执行
   */
  rejectExecution(executionId: string, reason?: string): { success: boolean; error?: string } {
    const result = this.repo.rejectExecution(executionId, reason);
    if (!result) {
      return { success: false, error: 'Approval not found or already resolved' };
    }

    console.error(`[Scheduler] Execution ${executionId} rejected`);
    return { success: true };
  }

  // =========================================================================
  // 执行历史
  // =========================================================================

  /**
   * 获取执行历史
   */
  getExecutionHistory(jobId: string, limit: number = 10): Execution[] {
    return this.repo.listExecutionsByJob(jobId, limit);
  }

  /**
   * 获取执行日志
   */
  getExecutionLogs(executionId: string, limit: number = 100, offset: number = 0) {
    return this.repo.getLogsByExecution(executionId, limit, offset);
  }

  /**
   * 分页获取所有执行记录
   */
  listExecutions(limit: number = 20, offset: number = 0) {
    return this.repo.listExecutions(limit, offset);
  }
}

// ============================================================================
// 单例导出
// ============================================================================

let schedulerInstance: CronScheduler | null = null;

/**
 * 获取调度器单例
 */
export function getScheduler(): CronScheduler {
  if (!schedulerInstance) {
    schedulerInstance = new CronScheduler();
  }
  return schedulerInstance;
}

/**
 * 销毁调度器
 */
export function destroyScheduler(): void {
  if (schedulerInstance) {
    schedulerInstance.stop();
    schedulerInstance = null;
  }
}
