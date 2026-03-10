/**
 * MCP Cron Server - 执行引擎
 *
 * 负责：
 * - 执行 AI Agent 任务（通过 opencode run）
 * - 流式日志写入（带缓冲区）
 * - 鲁棒性心跳更新（递归 setTimeout + 容错）
 * - 硬超时强杀保护
 * - 审批请求触发
 *
 * @module executor
 */
import type { CronJob, CronJobResult, ExecutionResult } from './types.js';
/**
 * 执行任务（新版 - 使用 Execution 记录）
 *
 * @param job - 任务定义
 * @param executionId - 可选的执行 ID（用于恢复执行）
 * @returns 执行结果
 */
export declare function executeJob(job: CronJob, executionId?: string): Promise<ExecutionResult>;
/**
 * 应用执行结果到任务状态
 * 用于更新任务的 nextRunAtMs 等字段
 */
export declare function applyJobResult(job: CronJob, result: CronJobResult | ExecutionResult, nowMs: number): {
    shouldDelete: boolean;
    updates: Partial<CronJob>;
};
/**
 * 检测并处理僵尸任务
 * （长时间无心跳的 running 状态任务）
 *
 * @param timeoutMs - 超时阈值（默认 5 分钟）
 * @returns 被标记为 failed 的执行记录数量
 */
export declare function detectStaleExecutions(timeoutMs?: number): number;
/**
 * 取消执行
 */
export declare function cancelExecution(executionId: string, reason?: string): boolean;
/**
 * 暂停执行
 */
export declare function pauseExecution(executionId: string, reason?: string): boolean;
/**
 * 恢复执行
 */
export declare function resumeExecution(executionId: string): boolean;
/**
 * 获取活跃执行数量
 */
export declare function getActiveExecutionCount(): number;
/**
 * 获取所有活跃执行 ID
 */
export declare function getActiveExecutionIds(): string[];
/**
 * 关闭所有执行
 */
export declare function shutdownAll(): void;
