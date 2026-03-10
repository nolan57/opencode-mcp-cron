/**
 * MCP Cron Server - 类型定义
 * 
 * 包含所有核心类型定义，与数据库 Schema 保持一致
 * 
 * @module types
 */

// ============================================================================
// 基础类型
// ============================================================================

/**
 * TraceId 类型 - 用于链路追踪
 * 格式: tr_<timestamp_hex>_<random_hex>
 */
export type TraceId = `tr_${string}`;

/**
 * 序列号类型 - 用于日志排序
 */
export type SequenceNum = number;

/**
 * 任务 ID 类型
 */
export type JobId = `job_${string}`;

/**
 * 执行 ID 类型
 */
export type ExecutionId = `exec_${string}`;

/**
 * 审批 ID 类型
 */
export type ApprovalId = `apr_${string}`;

// ============================================================================
// 调度类型
// ============================================================================

/**
 * 调度配置
 * 支持三种类型：一次性任务、间隔任务、Cron 表达式
 */
export type CronSchedule =
  | { kind: 'at'; atMs: number }
  | { kind: 'every'; everyMs: number; anchorMs?: number }
  | { kind: 'cron'; expr: string; tz?: string };

// ============================================================================
// 任务负载类型
// ============================================================================

/**
 * 任务负载类型
 */
export type CronPayloadKind = 'agentTurn' | 'systemEvent';

/**
 * 任务负载配置
 */
export type CronPayload = {
  kind: CronPayloadKind;
  message: string;
  deliver?: boolean;
  channel?: string;
  to?: string;
  model?: string;
};

// ============================================================================
// 任务选项
// ============================================================================

/**
 * 任务执行选项
 */
export type CronJobOptions = {
  /** 执行后删除（一次性任务） */
  deleteAfterRun?: boolean;
  /** 启用重试 */
  retry?: boolean;
  /** 最大重试次数 */
  maxRetries?: number;
  /** 执行超时（毫秒） */
  timeoutMs?: number;
  /** 是否需要审批 */
  requiresApproval?: boolean;
};

/**
 * 任务配置（存储在 config_json 字段）
 */
export type JobConfig = {
  /** 是否需要人工审批 */
  requiresApproval?: boolean;
  /** 上下文 Schema 定义 */
  contextSchema?: Record<string, unknown>;
  /** 最大执行时长（毫秒） */
  maxDurationMs?: number;
  /** 超时行为 */
  timeoutBehavior?: 'fail' | 'pause' | 'ignore';
  /** 通知渠道列表 */
  notificationChannels?: string[];
  /** 标签 */
  tags?: string[];
  /** 自定义元数据 */
  metadata?: Record<string, unknown>;
};

// ============================================================================
// 执行状态类型
// ============================================================================

/**
 * 执行状态枚举
 * 支持状态机流转
 * 
 * 状态转换图:
 * pending -> running -> success
 *         -> running -> failed
 *         -> running -> waiting_for_approval -> pending (approved)
 *                                           -> failed (rejected)
 *         -> running -> paused -> running
 *         -> cancelled
 */
export type ExecutionStatus =
  | 'pending'           // 等待执行
  | 'running'           // 执行中
  | 'success'           // 执行成功
  | 'failed'            // 执行失败
  | 'waiting_for_approval'  // 等待审批
  | 'paused'            // 已暂停
  | 'cancelled';        // 已取消

/**
 * 执行状态转换规则
 */
export const VALID_STATUS_TRANSITIONS: Record<ExecutionStatus, ExecutionStatus[]> = {
  pending: ['running', 'cancelled'],
  running: ['success', 'failed', 'waiting_for_approval', 'paused'],
  success: [],
  failed: [],
  waiting_for_approval: ['pending', 'failed'],
  paused: ['running', 'cancelled'],
  cancelled: [],
};

/**
 * 判断状态转换是否有效
 */
export function isValidTransition(from: ExecutionStatus, to: ExecutionStatus): boolean {
  return VALID_STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * 旧版运行状态（向后兼容）
 * @deprecated 使用 ExecutionStatus 替代
 */
export type CronRunStatus = 'ok' | 'error' | 'skipped';

/**
 * 将旧版状态映射到新版
 */
export function mapLegacyStatus(status: CronRunStatus): ExecutionStatus {
  switch (status) {
    case 'ok': return 'success';
    case 'error': return 'failed';
    case 'skipped': return 'cancelled';
  }
}

/**
 * 将新版状态映射到旧版（向后兼容）
 */
export function mapToLegacyStatus(status: ExecutionStatus): CronRunStatus | null {
  switch (status) {
    case 'success': return 'ok';
    case 'failed': return 'error';
    case 'cancelled': return 'skipped';
    default: return null;
  }
}

// ============================================================================
// 日志类型
// ============================================================================

/**
 * 日志级别枚举
 */
export type LogLevel = 'info' | 'error' | 'warn' | 'debug' | 'stream';

/**
 * 日志级别权重（用于过滤）
 */
export const LOG_LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  stream: 2,
  warn: 3,
  error: 4,
};

// ============================================================================
// 审批类型
// ============================================================================

/**
 * 审批状态枚举
 */
export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

// ============================================================================
// 任务状态（兼容旧版）
// ============================================================================

/**
 * 任务运行时状态
 */
export type CronJobState = {
  /** 下次执行时间（毫秒时间戳） */
  nextRunAtMs?: number;
  /** 当前执行开始时间 */
  runningAtMs?: number;
  /** 上次执行完成时间 */
  lastRunAtMs?: number;
  /** 上次执行状态 */
  lastStatus?: CronRunStatus;
  /** 上次错误信息 */
  lastError?: string;
  /** 上次执行耗时（毫秒） */
  lastDurationMs?: number;
  /** 连续错误次数 */
  consecutiveErrors?: number;
  /** 当前执行的 ID */
  currentExecutionId?: ExecutionId;
};

// ============================================================================
// 任务定义
// ============================================================================

/**
 * 完整任务定义
 */
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
  config?: JobConfig;
  state: CronJobState;
  /** 是否活跃（软删除标记） */
  isActive?: boolean;
};

/**
 * 创建任务参数
 */
export type CronJobCreate = Omit<CronJob, 'id' | 'createdAtMs' | 'updatedAtMs' | 'state' | 'isActive'> & {
  state?: Partial<CronJobState>;
};

/**
 * 更新任务参数
 */
export type CronJobPatch = Partial<Omit<CronJob, 'id' | 'createdAtMs' | 'state'>>;

/**
 * @deprecated 使用 Repository 替代
 */
export type CronStore = {
  version: 1;
  jobs: CronJob[];
};

// ============================================================================
// 执行记录
// ============================================================================

/**
 * 执行记录
 */
export type Execution = {
  id: ExecutionId;
  jobId: JobId;
  status: ExecutionStatus;
  startedAt: number | null;
  finishedAt: number | null;
  lastHeartbeat: number | null;
  errorMessage: string | null;
  errorStack: string | null;
  contextJson: string | null;
  resultJson: string | null;
  traceId: TraceId | null;
  durationMs: number | null;
  retryCount: number;
  createdAt: number;
  updatedAt: number;
};

/**
 * 创建执行记录参数
 */
export type ExecutionCreate = {
  jobId: string;
  traceId?: string;
  contextJson?: string;
};

/**
 * 执行结果（兼容旧版）
 */
export type CronJobResult = {
  status: CronRunStatus;
  error?: string;
  output?: string;
  durationMs?: number;
};

/**
 * 新版执行结果
 */
export type ExecutionResult = {
  status: ExecutionStatus;
  error?: string;
  errorStack?: string;
  output?: string;
  durationMs?: number;
  context?: Record<string, unknown>;
};

// ============================================================================
// 日志记录
// ============================================================================

/**
 * 日志条目
 */
export type LogEntry = {
  id?: number;
  executionId: ExecutionId;
  timestamp: number;
  level: LogLevel;
  content: string;
  sequenceNum: SequenceNum;
  metadataJson?: string;
};

/**
 * 创建日志参数
 */
export type LogCreate = {
  executionId: string;
  level: LogLevel;
  content: string;
  metadata?: Record<string, unknown>;
};

// ============================================================================
// 审批记录
// ============================================================================

/**
 * 审批记录
 */
export type Approval = {
  id: ApprovalId;
  executionId: ExecutionId;
  status: ApprovalStatus;
  requestMessage: string | null;
  requestContextJson: string | null;
  note: string | null;
  resolvedBy: string | null;
  resolvedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

/**
 * 创建审批参数
 */
export type ApprovalCreate = {
  executionId: string;
  requestMessage?: string;
  requestContextJson?: string;
};

// ============================================================================
// 分页 & 查询
// ============================================================================

/**
 * 分页查询结果
 */
export type PaginatedResult<T> = {
  items: T[];
  total: number;
  hasMore: boolean;
  cursor?: string | number;
};

/**
 * 查询选项
 */
export type QueryOptions = {
  limit?: number;
  offset?: number;
  cursor?: string | number;
  includeInactive?: boolean;
};

// ============================================================================
// 统计类型
// ============================================================================

/**
 * 系统统计信息
 */
export type SystemStats = {
  totalJobs: number;
  activeJobs: number;
  totalExecutions: number;
  todayExecutions: number;
  runningExecutions: number;
  pendingApprovals: number;
  avgDurationMs: number | null;
  errorRate: number;
};

/**
 * 调度器状态（兼容旧版）
 */
export type CronStatus = {
  enabled: boolean;
  jobs: number;
  nextWakeAtMs: number | null;
  running: boolean;
};

/**
 * 扩展调度器状态
 */
export type SchedulerStatus = CronStatus & {
  activeExecutions: number;
  pendingApprovals: number;
  lastTickAt: number | null;
  uptimeMs: number;
};

// ============================================================================
// 错误类型
// ============================================================================

/**
 * 任务错误类型
 */
export type JobError = {
  type: 'timeout' | 'execution' | 'approval' | 'system';
  message: string;
  stack?: string;
  timestamp: number;
  retryable: boolean;
};

/**
 * 重试策略
 */
export type RetryPolicy = {
  maxRetries: number;
  backoffMs: number[];
  retryableErrors: string[];
};

/**
 * 默认错误退避时间表
 */
export const DEFAULT_ERROR_BACKOFF_MS = [
  30_000,    // 1st error → 30 seconds
  60_000,    // 2nd error → 1 minute
  300_000,   // 3rd error → 5 minutes
  900_000,   // 4th error → 15 minutes
  3_600_000, // 5th+ error → 60 minutes
];

/**
 * 获取错误退避时间
 */
export function getErrorBackoffMs(consecutiveErrors: number): number {
  const idx = Math.min(consecutiveErrors, DEFAULT_ERROR_BACKOFF_MS.length - 1);
  return DEFAULT_ERROR_BACKOFF_MS[Math.max(0, idx)];
}