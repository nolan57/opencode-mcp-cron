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
import type { CronJob, CronJobCreate, CronJobPatch, SchedulerStatus, Execution } from './types.js';
/**
 * 调度控制器
 *
 * 使用递归 setTimeout + 分批限流保证稳定性：
 * 1. 每次 tick 完全结束后才调度下一次，防止循环重叠
 * 2. 每批最多处理 MAX_BATCH_SIZE 个任务，防止惊群效应
 * 3. 动态休眠算法优化调度效率
 */
declare class CronScheduler {
    /** 主调度定时器 */
    private loopTimer;
    /** 僵尸检测定时器 */
    private staleCheckTimer;
    /** 是否已停止 */
    private stopped;
    /** 启动时间 */
    private startedAt;
    /** 上次 tick 开始时间 */
    private lastTickAt;
    /** 上次 tick 结束时间 */
    private lastTickEndAt;
    /** 数据仓库 */
    private repo;
    /** 正在处理的任务数 */
    private processingCount;
    /** 是否正在执行 tick（防止重入） */
    private isTicking;
    constructor();
    /**
     * 启动调度器
     */
    start(): void;
    /**
     * 停止调度器
     */
    stop(): void;
    /**
     * 启动僵尸任务检测
     */
    private startStaleCheck;
    /**
     * 调度下一次循环
     *
     * 递归 setTimeout 模式：
     * - 确保当前循环完全结束后才调度下一次
     * - 防止多个 runLoop 实例并发运行
     * - 错误不会中断调度链
     */
    private scheduleNextLoop;
    /**
     * 执行调度循环
     *
     * 确保串行化执行：
     * - await 当前循环完成
     * - 在 finally 中调度下一次
     */
    private executeLoop;
    /**
     * 计算下次调度延迟
     *
     * 动态休眠算法：
     * - 有积压任务时使用快速轮询（1秒）
     * - 否则根据下次唤醒时间计算
     */
    private calculateNextDelay;
    /**
     * 主调度循环
     *
     * 分批限流：
     * - 每次最多处理 MAX_BATCH_SIZE 个任务
     * - 剩余任务在下一个调度周期处理
     */
    private runLoop;
    /**
     * 获取到期的任务（带分批限流）
     *
     * 状态机驱动：
     * - 仅查询 status='pending' 且 next_run_at <= now 的任务
     * - 跳过 waiting_for_approval 或 paused 状态的任务
     * - 分批限流：最多返回 MAX_BATCH_SIZE 个
     */
    private getDueJobsWithLimit;
    /**
     * 异步执行任务（不阻塞调度循环）
     */
    private executeJobAsync;
    /**
     * 处理需要审批的任务
     */
    private handleApprovalRequired;
    /**
     * 处理执行错误
     */
    private handleExecutionError;
    /**
     * 添加任务
     */
    addJob(input: CronJobCreate): CronJob;
    /**
     * 更新任务
     */
    updateJob(id: string, patch: CronJobPatch): CronJob | null;
    /**
     * 删除任务
     */
    removeJob(id: string): boolean;
    /**
     * 列出所有任务
     */
    listJobs(includeInactive?: boolean): CronJob[];
    /**
     * 获取单个任务
     */
    getJob(id: string): CronJob | null;
    /**
     * 获取调度器状态
     */
    getStatus(): SchedulerStatus;
    /**
     * 立即执行任务
     */
    runJobNow(id: string): Promise<{
        success: boolean;
        error?: string;
        executionId?: string;
    }>;
    /**
     * 获取待审批列表
     */
    getPendingApprovals(): Array<{
        approvalId: string;
        executionId: string;
        jobId: string;
        jobName: string;
        requestMessage: string | null;
        createdAt: number;
    }>;
    /**
     * 批准执行
     */
    approveExecution(executionId: string, note?: string): {
        success: boolean;
        error?: string;
    };
    /**
     * 拒绝执行
     */
    rejectExecution(executionId: string, reason?: string): {
        success: boolean;
        error?: string;
    };
    /**
     * 获取执行历史
     */
    getExecutionHistory(jobId: string, limit?: number): Execution[];
    /**
     * 获取执行日志
     */
    getExecutionLogs(executionId: string, limit?: number, offset?: number): import("./repository.js").PaginatedResult<import("./repository.js").LogEntry>;
    /**
     * 分页获取所有执行记录
     */
    listExecutions(limit?: number, offset?: number): {
        items: import("./repository.js").Execution[];
        total: number;
        hasMore: boolean;
    };
}
/**
 * 获取调度器单例
 */
export declare function getScheduler(): CronScheduler;
/**
 * 销毁调度器
 */
export declare function destroyScheduler(): void;
export {};
