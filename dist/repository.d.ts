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
import { type ExecutionStatus, type LogLevel, type ApprovalStatus } from './database.js';
import type { CronJob, CronJobCreate, CronJobPatch } from './types.js';
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
    resultJson?: string | null;
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
/**
 * 数据访问层
 */
export declare class Repository {
    private db;
    private logBuffer;
    private insertJobStmt;
    private updateJobStmt;
    private getJobByIdStmt;
    private listJobsStmt;
    private listEnabledJobsStmt;
    private deleteJobStmt;
    private updateJobNextRunStmt;
    private insertExecutionStmt;
    private getExecutionByIdStmt;
    private updateExecutionStatusStmt;
    private updateExecutionHeartbeatStmt;
    private listExecutionsByJobStmt;
    private getRunningExecutionsStmt;
    private getNextDueExecutionStmt;
    private getRecentExecutionsStmt;
    private listExecutionsStmt;
    private getTotalExecutionsStmt;
    private getLogsByExecutionStmt;
    private getLogCountStmt;
    private insertApprovalStmt;
    private getApprovalByExecutionStmt;
    private updateApprovalStatusStmt;
    private listPendingApprovalsStmt;
    private getStatsStmt;
    constructor();
    /**
     * 准备所有预处理语句
     */
    private prepareStatements;
    /**
     * 创建任务
     */
    createJob(input: CronJobCreate): CronJob;
    /**
     * 更新任务
     */
    updateJob(id: string, patch: CronJobPatch): CronJob | null;
    /**
     * 获取任务
     */
    getJob(id: string): CronJob | null;
    /**
     * 列出所有任务
     */
    listJobs(includeInactive?: boolean): CronJob[];
    /**
     * 列出启用的任务
     */
    listEnabledJobs(): CronJob[];
    /**
     * 删除任务（软删除）
     */
    deleteJob(id: string): boolean;
    /**
     * 更新任务下次执行时间
     */
    updateJobNextRun(id: string, nextRunAt: number | null): void;
    /**
     * 将数据库行转换为 CronJob 对象
     */
    private rowToJob;
    /**
     * 创建执行记录
     */
    createExecution(input: ExecutionCreate): Execution;
    /**
     * 获取执行记录
     */
    getExecution(id: string): Execution | null;
    /**
     * 更新执行状态（原子操作）
     */
    updateExecutionStatus(id: string, update: ExecutionUpdate): boolean;
    /**
     * 原子状态转换：仅当当前状态匹配时才更新
     * 用于防止竞态条件
     */
    transitionExecutionStatus(id: string, fromStatus: ExecutionStatus, toStatus: ExecutionStatus, additionalUpdate?: Partial<ExecutionUpdate>): boolean;
    /**
     * 更新心跳
     */
    updateHeartbeat(id: string): boolean;
    /**
     * 列出任务的历史执行记录
     */
    listExecutionsByJob(jobId: string, limit?: number): Execution[];
    /**
     * 获取正在运行的执行
     */
    getRunningExecutions(): Execution[];
    /**
     * 获取下一个待执行的任务
     */
    getNextDueExecution(): {
        execution: Execution;
        job: CronJob;
    } | null;
    /**
     * 获取最近完成的执行
     */
    getRecentExecutions(limit?: number): Execution[];
    /**
     * 分页查询所有执行记录
     *
     * @param limit 每页数量，默认 20，最大 100
     * @param offset 偏移量，默认 0
     * @returns 执行记录列表、总数、是否有更多
     */
    listExecutions(limit?: number, offset?: number): {
        items: Execution[];
        total: number;
        hasMore: boolean;
    };
    /**
     * 获取执行记录总数
     */
    getTotalExecutionsCount(): number;
    /**
     * 检测僵尸任务（长时间无心跳的运行中任务）
     */
    getStaleExecutions(timeoutMs?: number): Execution[];
    /**
     * 将数据库行转换为 Execution 对象
     */
    private rowToExecution;
    /**
     * 追加日志（缓冲写入）
     */
    appendLog(executionId: string, level: LogLevel, content: string, metadata?: Record<string, unknown>): void;
    /**
     * 强制刷新日志缓冲区
     */
    flushLogs(): void;
    /**
     * 异步刷新日志缓冲区
     */
    flushLogsAsync(): Promise<void>;
    /**
     * 获取执行的日志（分页）
     */
    getLogsByExecution(executionId: string, limit?: number, offset?: number): PaginatedResult<LogEntry>;
    /**
     * 清除执行记录的日志序列缓存
     */
    clearLogSequence(executionId: string): void;
    /**
     * 获取日志缓冲区大小
     */
    getLogBufferSize(): number;
    /**
     * 创建审批请求
     */
    createApproval(input: ApprovalCreate): Approval;
    /**
     * 获取执行的审批记录
     */
    getApprovalByExecution(executionId: string): Approval | null;
    /**
     * 批准执行
     */
    approveExecution(executionId: string, note?: string, resolvedBy?: string): {
        approval: Approval;
        execution: Execution;
    } | null;
    /**
     * 拒绝执行
     */
    rejectExecution(executionId: string, reason?: string, resolvedBy?: string): {
        approval: Approval;
        execution: Execution;
    } | null;
    /**
     * 列出待审批的请求
     */
    listPendingApprovals(): Array<Approval & {
        jobId: string;
        jobName: string;
    }>;
    /**
     * 将数据库行转换为 Approval 对象
     */
    private rowToApproval;
    /**
     * 获取系统统计信息
     */
    getSystemStats(): SystemStats;
    /**
     * 获取下一个唤醒时间
     */
    getNextWakeTime(): number | null;
    /**
     * 事务包装
     */
    transaction<T>(fn: () => T): T;
    /**
     * 销毁资源
     */
    destroy(): void;
}
/**
 * 获取 Repository 单例
 */
export declare function getRepository(): Repository;
/**
 * 销毁 Repository
 */
export declare function destroyRepository(): void;
