/**
 * MCP Cron Server - 数据访问层
 * 
 * 基于 SQLite 的数据访问实现，包含：
 * - Job CRUD 操作
 * - Execution 状态管理
 * - 日志缓冲区 + 批量写入
 * - Approval 审批流程
 * 
 * ⚠️ 日志缓冲区设计：
 * better-sqlite3 是同步库，高频日志写入会阻塞事件循环。
 * 本模块实现内存缓冲区：
 * - 日志先 push 到队列
 * - 每 500ms 或攒够 50 条批量事务写入
 * - 任务结束时调用 flush() 强制刷新
 * 
 * @module repository
 */

import type Database from 'better-sqlite3';
import {
  getDatabase,
  generateId,
  generateTraceId,
  type ExecutionStatus,
  type LogLevel,
  type ApprovalStatus,
} from './database.js';
import type {
  CronJob,
  CronJobCreate,
  CronJobPatch,
  CronSchedule,
  CronPayload,
  CronJobOptions,
} from './types.js';

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 任务配置（存储在 config_json 字段）
 */
export interface JobConfig {
  requiresApproval?: boolean;
  contextSchema?: Record<string, unknown>;
  maxDurationMs?: number;
  timeoutBehavior?: 'fail' | 'pause' | 'ignore';
  notificationChannels?: string[];
  tags?: string[];
}

/**
 * 执行记录
 */
export interface Execution {
  id: string;
  jobId: string;
  status: ExecutionStatus;
  startedAt: number | null;
  finishedAt: number | null;
  lastHeartbeat: number | null;
  errorMessage: string | null;
  errorStack: string | null;
  contextJson: string | null;
  resultJson: string | null;
  traceId: string | null;
  durationMs: number | null;
  retryCount: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * 执行创建参数
 */
export interface ExecutionCreate {
  jobId: string;
  traceId?: string;
  contextJson?: string;
}

/**
 * 执行状态更新参数
 */
export interface ExecutionUpdate {
  status?: ExecutionStatus;
  startedAt?: number;
  finishedAt?: number;
  lastHeartbeat?: number;
  errorMessage?: string;
  errorStack?: string;
  contextJson?: string;
  resultJson?: string;
  durationMs?: number;
  retryCount?: number;
}

/**
 * 日志条目
 */
export interface LogEntry {
  id?: number;
  executionId: string;
  timestamp: number;
  level: LogLevel;
  content: string;
  sequenceNum: number;
  metadataJson?: string;
}

/**
 * 审批记录
 */
export interface Approval {
  id: string;
  executionId: string;
  status: ApprovalStatus;
  requestMessage: string | null;
  requestContextJson: string | null;
  note: string | null;
  resolvedBy: string | null;
  resolvedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * 审批创建参数
 */
export interface ApprovalCreate {
  executionId: string;
  requestMessage?: string;
  requestContextJson?: string;
}

/**
 * 分页查询结果
 */
export interface PaginatedResult<T> {
  items: T[];
  total: number;
  hasMore: boolean;
  cursor?: string | number;
}

/**
 * 统计信息
 */
export interface SystemStats {
  totalJobs: number;
  activeJobs: number;
  totalExecutions: number;
  todayExecutions: number;
  runningExecutions: number;
  pendingApprovals: number;
  avgDurationMs: number | null;
  errorRate: number;
}

// ============================================================================
// 日志缓冲区
// ============================================================================

/**
 * 缓冲日志条目（内部使用）
 */
interface BufferedLog {
  executionId: string;
  timestamp: number;
  level: LogLevel;
  content: string;
  sequenceNum: number;
  metadataJson?: string;
}

/**
 * 日志缓冲区配置
 */
interface LogBufferConfig {
  maxBufferSize: number;      // 最大缓冲数量
  flushIntervalMs: number;    // 刷新间隔
  batchSize: number;          // 单次写入批次大小
}

const DEFAULT_LOG_BUFFER_CONFIG: LogBufferConfig = {
  maxBufferSize: 1000,        // 最大缓冲 1000 条
  flushIntervalMs: 500,       // 500ms 刷新一次
  batchSize: 50,              // 每批写入 50 条
};

/**
 * 日志缓冲区类
 * 收集日志并批量写入数据库，避免高频同步写入阻塞事件循环
 */
class LogBuffer {
  private buffer: BufferedLog[] = [];
  private config: LogBufferConfig;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private sequenceCounters: Map<string, number> = new Map();
  private db: Database.Database;
  private isFlushing: boolean = false;
  private flushPromise: Promise<void> | null = null;

  // 预处理语句
  private insertLogStmt: Database.Statement;
  private insertManyLogsStmt: Database.Statement;

  constructor(db: Database.Database, config: Partial<LogBufferConfig> = {}) {
    this.db = db;
    this.config = { ...DEFAULT_LOG_BUFFER_CONFIG, ...config };
    
    // 准备预处理语句
    this.insertLogStmt = this.db.prepare(`
      INSERT INTO logs (execution_id, timestamp, level, content, sequence_num, metadata_json)
      VALUES (@executionId, @timestamp, @level, @content, @sequenceNum, @metadataJson)
    `);
    
    this.insertManyLogsStmt = this.db.prepare(`
      INSERT INTO logs (execution_id, timestamp, level, content, sequence_num, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    // 启动定时刷新
    this.startFlushTimer();
  }

  /**
   * 获取下一个序列号
   */
  private getNextSequence(executionId: string): number {
    let seq = this.sequenceCounters.get(executionId) ?? 0;
    seq += 1;
    this.sequenceCounters.set(executionId, seq);
    return seq;
  }

  /**
   * 添加日志到缓冲区
   */
  append(
    executionId: string,
    level: LogLevel,
    content: string,
    metadataJson?: string
  ): void {
    const log: BufferedLog = {
      executionId,
      timestamp: Date.now(),
      level,
      content,
      sequenceNum: this.getNextSequence(executionId),
      metadataJson,
    };

    this.buffer.push(log);

    // 如果缓冲区达到阈值，触发异步刷新
    if (this.buffer.length >= this.config.batchSize) {
      this.scheduleFlush();
    }

    // 防止缓冲区过大（内存保护）
    if (this.buffer.length >= this.config.maxBufferSize) {
      console.warn('[LogBuffer] Buffer overflow, forcing flush');
      this.flushSync();
    }
  }

  /**
   * 启动定时刷新
   */
  private startFlushTimer(): void {
    if (this.flushTimer) return;
    
    this.flushTimer = setInterval(() => {
      if (this.buffer.length > 0) {
        this.scheduleFlush();
      }
    }, this.config.flushIntervalMs);
    
    // 不阻止进程退出
    if (this.flushTimer.unref) {
      this.flushTimer.unref();
    }
  }

  /**
   * 停止定时刷新
   */
  stopFlushTimer(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  /**
   * 调度异步刷新（避免在事件循环中直接执行）
   */
  private scheduleFlush(): void {
    if (this.isFlushing) return;
    
    // 使用 setImmediate 在下一个事件循环迭代中执行
    setImmediate(() => this.flushAsync());
  }

  /**
   * 异步刷新（非阻塞）
   */
  async flushAsync(): Promise<void> {
    if (this.isFlushing) {
      return this.flushPromise ?? Promise.resolve();
    }
    
    this.isFlushing = true;
    this.flushPromise = this.doFlush();
    
    try {
      await this.flushPromise;
    } finally {
      this.isFlushing = false;
      this.flushPromise = null;
    }
  }

  /**
   * 同步刷新（用于关键路径）
   */
  flushSync(): void {
    if (this.buffer.length === 0) return;
    
    const logs = this.buffer.splice(0, this.buffer.length);
    this.writeLogsInBatches(logs);
  }

  /**
   * 执行刷新
   */
  private async doFlush(): Promise<void> {
    if (this.buffer.length === 0) return;
    
    // 取出所有待写日志
    const logs = this.buffer.splice(0, this.buffer.length);
    
    // 批量写入
    this.writeLogsInBatches(logs);
  }

  /**
   * 分批写入日志（事务）
   */
  private writeLogsInBatches(logs: BufferedLog[]): void {
    if (logs.length === 0) return;

    const batchSize = this.config.batchSize;
    
    for (let i = 0; i < logs.length; i += batchSize) {
      const batch = logs.slice(i, i + batchSize);
      
      try {
        const insertMany = this.db.transaction((items: BufferedLog[]) => {
          for (const log of items) {
            this.insertManyLogsStmt.run(
              log.executionId,
              log.timestamp,
              log.level,
              log.content,
              log.sequenceNum,
              log.metadataJson ?? null
            );
          }
        });
        
        insertMany(batch);
      } catch (error) {
        console.error('[LogBuffer] Batch write failed:', error);
        // 记录失败的日志数量
        console.error(`[LogBuffer] Lost ${batch.length} log entries`);
      }
    }
  }

  /**
   * 清空执行记录的序列号缓存
   */
  clearSequence(executionId: string): void {
    this.sequenceCounters.delete(executionId);
  }

  /**
   * 获取缓冲区大小
   */
  get size(): number {
    return this.buffer.length;
  }

  /**
   * 销毁缓冲区
   */
  destroy(): void {
    this.stopFlushTimer();
    this.flushSync();
    this.buffer = [];
    this.sequenceCounters.clear();
  }
}

// ============================================================================
// Repository 类
// ============================================================================

/**
 * 数据访问层
 */
export class Repository {
  private db: Database.Database;
  private logBuffer: LogBuffer;

  // 预处理语句 - Jobs
  private insertJobStmt: Database.Statement;
  private updateJobStmt: Database.Statement;
  private getJobByIdStmt: Database.Statement;
  private listJobsStmt: Database.Statement;
  private listEnabledJobsStmt: Database.Statement;
  private deleteJobStmt: Database.Statement;
  private updateJobNextRunStmt: Database.Statement;

  // 预处理语句 - Executions
  private insertExecutionStmt: Database.Statement;
  private getExecutionByIdStmt: Database.Statement;
  private updateExecutionStatusStmt: Database.Statement;
  private updateExecutionHeartbeatStmt: Database.Statement;
  private listExecutionsByJobStmt: Database.Statement;
  private getRunningExecutionsStmt: Database.Statement;
  private getNextDueExecutionStmt: Database.Statement;
  private getRecentExecutionsStmt: Database.Statement;
  private listExecutionsStmt: Database.Statement;
  private getTotalExecutionsStmt: Database.Statement;

  // 预处理语句 - Logs
  private getLogsByExecutionStmt: Database.Statement;
  private getLogCountStmt: Database.Statement;

  // 预处理语句 - Approvals
  private insertApprovalStmt: Database.Statement;
  private getApprovalByExecutionStmt: Database.Statement;
  private updateApprovalStatusStmt: Database.Statement;
  private listPendingApprovalsStmt: Database.Statement;

  // 预处理语句 - Stats
  private getStatsStmt: Database.Statement;

  constructor() {
    this.db = getDatabase().getDatabase();
    this.logBuffer = new LogBuffer(this.db);
    
    this.prepareStatements();
  }

  /**
   * 准备所有预处理语句
   */
  private prepareStatements(): void {
    // Jobs
    this.insertJobStmt = this.db.prepare(`
      INSERT INTO jobs (id, name, description, enabled, schedule_json, payload_json, options_json, config_json, created_at, updated_at, next_run_at)
      VALUES (@id, @name, @description, @enabled, @scheduleJson, @payloadJson, @optionsJson, @configJson, @createdAt, @updatedAt, @nextRunAt)
    `);

    this.updateJobStmt = this.db.prepare(`
      UPDATE jobs SET
        name = @name,
        description = @description,
        enabled = @enabled,
        schedule_json = @scheduleJson,
        payload_json = @payloadJson,
        options_json = @optionsJson,
        config_json = @configJson,
        updated_at = @updatedAt,
        next_run_at = @nextRunAt
      WHERE id = @id
    `);

    this.getJobByIdStmt = this.db.prepare(`
      SELECT * FROM jobs WHERE id = ?
    `);

    this.listJobsStmt = this.db.prepare(`
      SELECT * FROM jobs ORDER BY created_at DESC
    `);

    this.listEnabledJobsStmt = this.db.prepare(`
      SELECT * FROM jobs WHERE enabled = 1 AND is_active = 1 ORDER BY next_run_at ASC
    `);

    this.deleteJobStmt = this.db.prepare(`
      UPDATE jobs SET is_active = 0, updated_at = ? WHERE id = ?
    `);

    this.updateJobNextRunStmt = this.db.prepare(`
      UPDATE jobs SET next_run_at = ?, updated_at = ? WHERE id = ?
    `);

    // Executions
    this.insertExecutionStmt = this.db.prepare(`
      INSERT INTO executions (id, job_id, status, trace_id, context_json, created_at, updated_at)
      VALUES (@id, @jobId, 'pending', @traceId, @contextJson, @createdAt, @updatedAt)
    `);

    this.getExecutionByIdStmt = this.db.prepare(`
      SELECT * FROM executions WHERE id = ?
    `);

    // 原子状态更新 - 使用 WHERE 条件防止竞态
    this.updateExecutionStatusStmt = this.db.prepare(`
      UPDATE executions SET
        status = @status,
        started_at = COALESCE(@startedAt, started_at),
        finished_at = COALESCE(@finishedAt, finished_at),
        error_message = @errorMessage,
        error_stack = @errorStack,
        result_json = @resultJson,
        duration_ms = @durationMs,
        retry_count = COALESCE(@retryCount, retry_count),
        updated_at = @updatedAt
      WHERE id = @id AND status != 'cancelled'
    `);

    this.updateExecutionHeartbeatStmt = this.db.prepare(`
      UPDATE executions SET last_heartbeat = ?, updated_at = ? WHERE id = ? AND status = 'running'
    `);

    this.listExecutionsByJobStmt = this.db.prepare(`
      SELECT * FROM executions WHERE job_id = ? ORDER BY created_at DESC LIMIT ?
    `);

    this.getRunningExecutionsStmt = this.db.prepare(`
      SELECT * FROM executions WHERE status = 'running' ORDER BY started_at ASC
    `);

    // 获取下一个待执行的任务
    this.getNextDueExecutionStmt = this.db.prepare(`
      SELECT e.*, j.schedule_json, j.payload_json, j.options_json
      FROM executions e
      JOIN jobs j ON e.job_id = j.id
      WHERE e.status = 'pending' AND j.enabled = 1 AND j.is_active = 1
      ORDER BY j.next_run_at ASC
      LIMIT 1
    `);

    this.getRecentExecutionsStmt = this.db.prepare(`
      SELECT * FROM executions 
      WHERE status IN ('success', 'failed') 
      ORDER BY finished_at DESC 
      LIMIT ?
    `);

    // 分页查询所有执行记录
    this.listExecutionsStmt = this.db.prepare(`
      SELECT e.*, j.name as job_name
      FROM executions e
      LEFT JOIN jobs j ON e.job_id = j.id
      ORDER BY e.created_at DESC
      LIMIT ? OFFSET ?
    `);

    this.getTotalExecutionsStmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM executions
    `);

    // Logs
    this.getLogsByExecutionStmt = this.db.prepare(`
      SELECT * FROM logs WHERE execution_id = ? ORDER BY sequence_num ASC LIMIT ? OFFSET ?
    `);

    this.getLogCountStmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM logs WHERE execution_id = ?
    `);

    // Approvals
    this.insertApprovalStmt = this.db.prepare(`
      INSERT INTO approvals (id, execution_id, status, request_message, request_context_json, created_at, updated_at)
      VALUES (@id, @executionId, 'pending', @requestMessage, @requestContextJson, @createdAt, @updatedAt)
    `);

    this.getApprovalByExecutionStmt = this.db.prepare(`
      SELECT * FROM approvals WHERE execution_id = ?
    `);

    this.updateApprovalStatusStmt = this.db.prepare(`
      UPDATE approvals SET
        status = @status,
        note = @note,
        resolved_by = @resolvedBy,
        resolved_at = @resolvedAt,
        updated_at = @updatedAt
      WHERE id = @id
    `);

    this.listPendingApprovalsStmt = this.db.prepare(`
      SELECT a.*, e.job_id, j.name as job_name
      FROM approvals a
      JOIN executions e ON a.execution_id = e.id
      JOIN jobs j ON e.job_id = j.id
      WHERE a.status = 'pending'
      ORDER BY a.created_at ASC
    `);

    // Stats
    this.getStatsStmt = this.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM jobs WHERE is_active = 1) as total_jobs,
        (SELECT COUNT(*) FROM jobs WHERE enabled = 1 AND is_active = 1) as active_jobs,
        (SELECT COUNT(*) FROM executions) as total_executions,
        (SELECT COUNT(*) FROM executions WHERE started_at > ?) as today_executions,
        (SELECT COUNT(*) FROM executions WHERE status = 'running') as running_executions,
        (SELECT COUNT(*) FROM approvals WHERE status = 'pending') as pending_approvals,
        (SELECT AVG(duration_ms) FROM executions WHERE status = 'success' AND duration_ms IS NOT NULL) as avg_duration,
        (SELECT CAST(
          (SELECT COUNT(*) FROM executions WHERE status = 'failed') AS FLOAT
        / NULLIF((SELECT COUNT(*) FROM executions WHERE status IN ('success', 'failed')), 0)
        * 100 AS INTEGER)) as error_rate
    `);
  }

  // =========================================================================
  // Job CRUD
  // =========================================================================

  /**
   * 创建任务
   */
  createJob(input: CronJobCreate): CronJob {
    const now = Date.now();
    const id = generateId('job');

    const job: CronJob = {
      id,
      name: input.name,
      description: input.description,
      enabled: input.enabled ?? true,
      schedule: input.schedule,
      payload: input.payload,
      options: input.options,
      createdAtMs: now,
      updatedAtMs: now,
      state: input.state ?? {},
    };

    this.db.transaction(() => {
      this.insertJobStmt.run({
        id: job.id,
        name: job.name,
        description: job.description ?? null,
        enabled: job.enabled ? 1 : 0,
        scheduleJson: JSON.stringify(job.schedule),
        payloadJson: JSON.stringify(job.payload),
        optionsJson: job.options ? JSON.stringify(job.options) : null,
        configJson: null,
        createdAt: job.createdAtMs,
        updatedAt: job.updatedAtMs,
        nextRunAt: job.state.nextRunAtMs ?? null,
      });
    })();

    return job;
  }

  /**
   * 更新任务
   */
  updateJob(id: string, patch: CronJobPatch): CronJob | null {
    const existing = this.getJob(id);
    if (!existing) return null;

    const now = Date.now();
    const updated: CronJob = {
      ...existing,
      ...patch,
      updatedAtMs: now,
    };

    this.db.transaction(() => {
      this.updateJobStmt.run({
        id: updated.id,
        name: updated.name,
        description: updated.description ?? null,
        enabled: updated.enabled ? 1 : 0,
        scheduleJson: JSON.stringify(updated.schedule),
        payloadJson: JSON.stringify(updated.payload),
        optionsJson: updated.options ? JSON.stringify(updated.options) : null,
        configJson: null,
        updatedAt: updated.updatedAtMs,
        nextRunAt: updated.state?.nextRunAtMs ?? null,
      });
    })();

    return updated;
  }

  /**
   * 获取任务
   */
  getJob(id: string): CronJob | null {
    const row = this.getJobByIdStmt.get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToJob(row);
  }

  /**
   * 列出所有任务
   */
  listJobs(includeInactive: boolean = false): CronJob[] {
    const rows = includeInactive
      ? this.listJobsStmt.all() as Record<string, unknown>[]
      : this.db.prepare('SELECT * FROM jobs WHERE is_active = 1 ORDER BY created_at DESC').all() as Record<string, unknown>[];
    
    return rows.map(row => this.rowToJob(row));
  }

  /**
   * 列出启用的任务
   */
  listEnabledJobs(): CronJob[] {
    const rows = this.listEnabledJobsStmt.all() as Record<string, unknown>[];
    return rows.map(row => this.rowToJob(row));
  }

  /**
   * 删除任务（软删除）
   */
  deleteJob(id: string): boolean {
    const result = this.deleteJobStmt.run(Date.now(), id);
    return result.changes > 0;
  }

  /**
   * 更新任务下次执行时间
   */
  updateJobNextRun(id: string, nextRunAt: number | null): void {
    this.updateJobNextRunStmt.run(nextRunAt, Date.now(), id);
  }

  /**
   * 将数据库行转换为 CronJob 对象
   */
  private rowToJob(row: Record<string, unknown>): CronJob {
    return {
      id: row.id as string,
      name: row.name as string,
      description: row.description as string | undefined,
      enabled: Boolean(row.enabled),
      schedule: JSON.parse(row.schedule_json as string) as CronSchedule,
      payload: JSON.parse(row.payload_json as string) as CronPayload,
      options: row.options_json ? JSON.parse(row.options_json as string) as CronJobOptions : undefined,
      createdAtMs: row.created_at as number,
      updatedAtMs: row.updated_at as number,
      state: {
        nextRunAtMs: row.next_run_at as number | undefined,
      },
    };
  }

  // =========================================================================
  // Execution CRUD
  // =========================================================================

  /**
   * 创建执行记录
   */
  createExecution(input: ExecutionCreate): Execution {
    const now = Date.now();
    const id = generateId('exec');
    const traceId = input.traceId ?? generateTraceId();

    this.db.transaction(() => {
      this.insertExecutionStmt.run({
        id,
        jobId: input.jobId,
        traceId,
        contextJson: input.contextJson ?? null,
        createdAt: now,
        updatedAt: now,
      });
    })();

    return {
      id,
      jobId: input.jobId,
      status: 'pending',
      startedAt: null,
      finishedAt: null,
      lastHeartbeat: null,
      errorMessage: null,
      errorStack: null,
      contextJson: input.contextJson ?? null,
      resultJson: null,
      traceId,
      durationMs: null,
      retryCount: 0,
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * 获取执行记录
   */
  getExecution(id: string): Execution | null {
    const row = this.getExecutionByIdStmt.get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToExecution(row);
  }

  /**
   * 更新执行状态（原子操作）
   */
  updateExecutionStatus(id: string, update: ExecutionUpdate): boolean {
    const now = Date.now();
    const result = this.updateExecutionStatusStmt.run({
      id,
      status: update.status ?? null,
      startedAt: update.startedAt ?? null,
      finishedAt: update.finishedAt ?? null,
      errorMessage: update.errorMessage ?? null,
      errorStack: update.errorStack ?? null,
      resultJson: update.resultJson ?? null,
      durationMs: update.durationMs ?? null,
      retryCount: update.retryCount ?? null,
      updatedAt: now,
    });
    return result.changes > 0;
  }

  /**
   * 原子状态转换：仅当当前状态匹配时才更新
   * 用于防止竞态条件
   */
  transitionExecutionStatus(
    id: string,
    fromStatus: ExecutionStatus,
    toStatus: ExecutionStatus,
    additionalUpdate?: Partial<ExecutionUpdate>
  ): boolean {
    const now = Date.now();
    
    const result = this.db.prepare(`
      UPDATE executions SET
        status = ?,
        started_at = COALESCE(?, started_at),
        finished_at = COALESCE(?, finished_at),
        error_message = ?,
        result_json = ?,
        duration_ms = ?,
        updated_at = ?
      WHERE id = ? AND status = ?
    `).run(
      toStatus,
      additionalUpdate?.startedAt ?? null,
      additionalUpdate?.finishedAt ?? null,
      additionalUpdate?.errorMessage ?? null,
      additionalUpdate?.resultJson ?? null,
      additionalUpdate?.durationMs ?? null,
      now,
      id,
      fromStatus
    );

    return result.changes > 0;
  }

  /**
   * 更新心跳
   */
  updateHeartbeat(id: string): boolean {
    const now = Date.now();
    const result = this.updateExecutionHeartbeatStmt.run(now, now, id);
    return result.changes > 0;
  }

  /**
   * 列出任务的历史执行记录
   */
  listExecutionsByJob(jobId: string, limit: number = 50): Execution[] {
    const rows = this.listExecutionsByJobStmt.all(jobId, limit) as Record<string, unknown>[];
    return rows.map(row => this.rowToExecution(row));
  }

  /**
   * 获取正在运行的执行
   */
  getRunningExecutions(): Execution[] {
    const rows = this.getRunningExecutionsStmt.all() as Record<string, unknown>[];
    return rows.map(row => this.rowToExecution(row));
  }

  /**
   * 获取下一个待执行的任务
   */
  getNextDueExecution(): { execution: Execution; job: CronJob } | null {
    const row = this.getNextDueExecutionStmt.get() as Record<string, unknown> | undefined;
    if (!row) return null;

    return {
      execution: this.rowToExecution(row),
      job: this.rowToJob(row),
    };
  }

  /**
   * 获取最近完成的执行
   */
  getRecentExecutions(limit: number = 10): Execution[] {
    const rows = this.getRecentExecutionsStmt.all(limit) as Record<string, unknown>[];
    return rows.map(row => this.rowToExecution(row));
  }

  /**
   * 分页查询所有执行记录
   * 
   * @param limit 每页数量，默认 20，最大 100
   * @param offset 偏移量，默认 0
   * @returns 执行记录列表、总数、是否有更多
   */
  listExecutions(limit: number = 20, offset: number = 0): { items: Execution[]; total: number; hasMore: boolean } {
    // 参数约束
    const safeLimit = Math.min(Math.max(1, limit), 100);
    const safeOffset = Math.max(0, offset);

    const rows = this.listExecutionsStmt.all(safeLimit, safeOffset) as Record<string, unknown>[];
    const totalRow = this.getTotalExecutionsStmt.get() as { count: number };
    const total = totalRow.count;
    const hasMore = safeOffset + rows.length < total;

    return {
      items: rows.map(row => this.rowToExecution(row)),
      total,
      hasMore,
    };
  }

  /**
   * 获取执行记录总数
   */
  getTotalExecutionsCount(): number {
    const row = this.getTotalExecutionsStmt.get() as { count: number };
    return row.count;
  }

  /**
   * 检测僵尸任务（长时间无心跳的运行中任务）
   */
  getStaleExecutions(timeoutMs: number = 300000): Execution[] {
    const cutoff = Date.now() - timeoutMs;
    const rows = this.db.prepare(`
      SELECT * FROM executions 
      WHERE status = 'running' 
      AND (last_heartbeat IS NULL AND started_at < ? OR last_heartbeat < ?)
    `).all(cutoff, cutoff) as Record<string, unknown>[];
    
    return rows.map(row => this.rowToExecution(row));
  }

  /**
   * 将数据库行转换为 Execution 对象
   */
  private rowToExecution(row: Record<string, unknown>): Execution {
    return {
      id: row.id as string,
      jobId: row.job_id as string,
      status: row.status as ExecutionStatus,
      startedAt: row.started_at as number | null,
      finishedAt: row.finished_at as number | null,
      lastHeartbeat: row.last_heartbeat as number | null,
      errorMessage: row.error_message as string | null,
      errorStack: row.error_stack as string | null,
      contextJson: row.context_json as string | null,
      resultJson: row.result_json as string | null,
      traceId: row.trace_id as string | null,
      durationMs: row.duration_ms as number | null,
      retryCount: row.retry_count as number,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }

  // =========================================================================
  // Logs (带缓冲区)
  // =========================================================================

  /**
   * 追加日志（缓冲写入）
   */
  appendLog(
    executionId: string,
    level: LogLevel,
    content: string,
    metadata?: Record<string, unknown>
  ): void {
    this.logBuffer.append(
      executionId,
      level,
      content,
      metadata ? JSON.stringify(metadata) : undefined
    );
  }

  /**
   * 强制刷新日志缓冲区
   */
  flushLogs(): void {
    this.logBuffer.flushSync();
  }

  /**
   * 异步刷新日志缓冲区
   */
  async flushLogsAsync(): Promise<void> {
    await this.logBuffer.flushAsync();
  }

  /**
   * 获取执行的日志（分页）
   */
  getLogsByExecution(
    executionId: string,
    limit: number = 100,
    offset: number = 0
  ): PaginatedResult<LogEntry> {
    const countRow = this.getLogCountStmt.get(executionId) as { count: number };
    const total = countRow.count;
    
    const rows = this.getLogsByExecutionStmt.all(executionId, limit, offset) as Record<string, unknown>[];
    
    return {
      items: rows.map(row => ({
        id: row.id as number,
        executionId: row.execution_id as string,
        timestamp: row.timestamp as number,
        level: row.level as LogLevel,
        content: row.content as string,
        sequenceNum: row.sequence_num as number,
        metadataJson: row.metadata_json as string | undefined,
      })),
      total,
      hasMore: offset + rows.length < total,
      cursor: rows.length > 0 ? (rows[rows.length - 1].id as number) : undefined,
    };
  }

  /**
   * 清除执行记录的日志序列缓存
   */
  clearLogSequence(executionId: string): void {
    this.logBuffer.clearSequence(executionId);
  }

  /**
   * 获取日志缓冲区大小
   */
  getLogBufferSize(): number {
    return this.logBuffer.size;
  }

  // =========================================================================
  // Approvals
  // =========================================================================

  /**
   * 创建审批请求
   */
  createApproval(input: ApprovalCreate): Approval {
    const now = Date.now();
    const id = generateId('apr');

    this.db.transaction(() => {
      this.insertApprovalStmt.run({
        id,
        executionId: input.executionId,
        requestMessage: input.requestMessage ?? null,
        requestContextJson: input.requestContextJson ?? null,
        createdAt: now,
        updatedAt: now,
      });
    })();

    return {
      id,
      executionId: input.executionId,
      status: 'pending',
      requestMessage: input.requestMessage ?? null,
      requestContextJson: input.requestContextJson ?? null,
      note: null,
      resolvedBy: null,
      resolvedAt: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * 获取执行的审批记录
   */
  getApprovalByExecution(executionId: string): Approval | null {
    const row = this.getApprovalByExecutionStmt.get(executionId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToApproval(row);
  }

  /**
   * 批准执行
   */
  approveExecution(executionId: string, note?: string, resolvedBy?: string): { approval: Approval; execution: Execution } | null {
    const approval = this.getApprovalByExecution(executionId);
    if (!approval || approval.status !== 'pending') return null;

    const now = Date.now();
    const updatedApproval: Approval = {
      ...approval,
      status: 'approved',
      note: note ?? null,
      resolvedBy: resolvedBy ?? null,
      resolvedAt: now,
      updatedAt: now,
    };

    this.db.transaction(() => {
      this.updateApprovalStatusStmt.run({
        id: approval.id,
        status: 'approved',
        note: note ?? null,
        resolvedBy: resolvedBy ?? null,
        resolvedAt: now,
        updatedAt: now,
      });

      // 将执行状态从 waiting_for_approval 改为 pending（待恢复执行）
      this.db.prepare(`
        UPDATE executions SET status = 'pending', updated_at = ? WHERE id = ? AND status = 'waiting_for_approval'
      `).run(now, executionId);
    })();

    const execution = this.getExecution(executionId);
    if (!execution) return null;

    return { approval: updatedApproval, execution };
  }

  /**
   * 拒绝执行
   */
  rejectExecution(executionId: string, reason?: string, resolvedBy?: string): { approval: Approval; execution: Execution } | null {
    const approval = this.getApprovalByExecution(executionId);
    if (!approval || approval.status !== 'pending') return null;

    const now = Date.now();
    const updatedApproval: Approval = {
      ...approval,
      status: 'rejected',
      note: reason ?? null,
      resolvedBy: resolvedBy ?? null,
      resolvedAt: now,
      updatedAt: now,
    };

    this.db.transaction(() => {
      this.updateApprovalStatusStmt.run({
        id: approval.id,
        status: 'rejected',
        note: reason ?? null,
        resolvedBy: resolvedBy ?? null,
        resolvedAt: now,
        updatedAt: now,
      });

      // 将执行状态改为 failed
      this.db.prepare(`
        UPDATE executions SET status = 'failed', error_message = ?, finished_at = ?, updated_at = ? WHERE id = ? AND status = 'waiting_for_approval'
      `).run(reason ?? 'Rejected by user', now, now, executionId);
    })();

    const execution = this.getExecution(executionId);
    if (!execution) return null;

    return { approval: updatedApproval, execution };
  }

  /**
   * 列出待审批的请求
   */
  listPendingApprovals(): Array<Approval & { jobId: string; jobName: string }> {
    const rows = this.listPendingApprovalsStmt.all() as Record<string, unknown>[];
    return rows.map(row => ({
      ...this.rowToApproval(row),
      jobId: row.job_id as string,
      jobName: row.job_name as string,
    }));
  }

  /**
   * 将数据库行转换为 Approval 对象
   */
  private rowToApproval(row: Record<string, unknown>): Approval {
    return {
      id: row.id as string,
      executionId: row.execution_id as string,
      status: row.status as ApprovalStatus,
      requestMessage: row.request_message as string | null,
      requestContextJson: row.request_context_json as string | null,
      note: row.note as string | null,
      resolvedBy: row.resolved_by as string | null,
      resolvedAt: row.resolved_at as number | null,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }

  // =========================================================================
  // Stats & Utilities
  // =========================================================================

  /**
   * 获取系统统计信息
   */
  getSystemStats(): SystemStats {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    
    const row = this.getStatsStmt.get(startOfDay.getTime()) as Record<string, unknown>;
    
    return {
      totalJobs: row.total_jobs as number,
      activeJobs: row.active_jobs as number,
      totalExecutions: row.total_executions as number,
      todayExecutions: row.today_executions as number,
      runningExecutions: row.running_executions as number,
      pendingApprovals: row.pending_approvals as number,
      avgDurationMs: row.avg_duration as number | null,
      errorRate: (row.error_rate as number) ?? 0,
    };
  }

  /**
   * 获取下一个唤醒时间
   */
  getNextWakeTime(): number | null {
    const row = this.db.prepare(`
      SELECT MIN(next_run_at) as next_wake FROM jobs WHERE enabled = 1 AND is_active = 1 AND next_run_at IS NOT NULL
    `).get() as { next_wake: number | null };
    
    return row.next_wake;
  }

  /**
   * 事务包装
   */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /**
   * 销毁资源
   */
  destroy(): void {
    this.logBuffer.destroy();
  }
}

// 单例实例
let repoInstance: Repository | null = null;

/**
 * 获取 Repository 单例
 */
export function getRepository(): Repository {
  if (!repoInstance) {
    repoInstance = new Repository();
  }
  return repoInstance;
}

/**
 * 销毁 Repository
 */
export function destroyRepository(): void {
  if (repoInstance) {
    repoInstance.destroy();
    repoInstance = null;
  }
}
