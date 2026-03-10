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

import { spawn, ChildProcess, exec } from "child_process";
import { promisify } from "util";
import { getRepository } from "./repository.js";
import { generateTraceId } from "./database.js";
import { computeNextRunAtMs } from "./schedule.js";
import type {
  CronJob,
  CronJobResult,
  ExecutionStatus,
  ExecutionResult,
  LogLevel,
  DEFAULT_ERROR_BACKOFF_MS,
} from "./types.js";
import { getErrorBackoffMs } from "./types.js";

// ============================================================================
// 配置常量
// ============================================================================

/** OpenCode 命令 */
const OPENCODE_COMMAND = process.env.OPENCODE_COMMAND || "opencode";

/** 默认软超时时间（5分钟）- 用于友好提示 */
const DEFAULT_SOFT_TIMEOUT_MS = 5 * 60 * 1000;

/** 默认硬超时时间（1小时）- 强制杀死进程 */
const DEFAULT_HARD_TIMEOUT_MS = 60 * 60 * 1000;

/** 心跳间隔（30秒） */
const HEARTBEAT_INTERVAL_MS = 30_000;

/** 日志刷新间隔（毫秒） */
const LOG_FLUSH_INTERVAL_MS = 1000;

/** 最大输出长度（用于存储到数据库） */
const MAX_OUTPUT_LENGTH = 10000;

/** 最大错误信息长度 */
const MAX_ERROR_LENGTH = 2000;

/** SIGKILL 前等待 SIGTERM 的宽限时间 */
const GRACEFUL_SHUTDOWN_MS = 5000;

/** Shell 执行助手 */
const execAsync = promisify(exec);

// ============================================================================
// 执行上下文
// ============================================================================

/**
 * 执行上下文
 * 跟踪正在执行的任务状态
 */
interface ExecutionContext {
  executionId: string;
  jobId: string;
  jobName: string;
  traceId: string;
  startTime: number;
  process: ChildProcess | null;
  /** 心跳定时器（递归 setTimeout 模式） */
  heartbeatTimer: ReturnType<typeof setTimeout> | null;
  /** 软超时定时器（发送警告） */
  softTimeoutTimer: ReturnType<typeof setTimeout> | null;
  /** 硬超时定时器（强制 SIGKILL） */
  hardTimeoutTimer: ReturnType<typeof setTimeout> | null;
  logBuffer: string[];
  /** 执行是否已完成 */
  isCompleted: boolean;
  /** 是否已被硬超时强杀 */
  isHardKilled: boolean;
}

// 活跃的执行上下文
const activeExecutions = new Map<string, ExecutionContext>();

// ============================================================================
// 主执行函数
// ============================================================================

/**
 * 执行任务（新版 - 使用 Execution 记录）
 *
 * @param job - 任务定义
 * @param executionId - 可选的执行 ID（用于恢复执行）
 * @returns 执行结果
 */
export async function executeJob(
  job: CronJob,
  executionId?: string,
): Promise<ExecutionResult> {
  const repo = getRepository();
  const startTime = Date.now();
  const traceId = generateTraceId();

  // 创建或获取执行记录
  let execution = executionId ? repo.getExecution(executionId) : null;

  if (!execution) {
    execution = repo.createExecution({
      jobId: job.id,
      traceId,
    });
  }

  const execId = execution.id;

  console.error(
    `[Executor] Starting execution: ${execId} for job: ${job.name} (${job.id})`,
  );

  // 更新状态为 running
  repo.transitionExecutionStatus(execId, "pending", "running", {
    startedAt: startTime,
  });

  // 计算超时时间（从 job.config 或 job.options 获取，默认 1 小时）
  const hardTimeoutMs =
    job.config?.maxDurationMs ??
    job.options?.timeoutMs ??
    DEFAULT_HARD_TIMEOUT_MS;

  // 创建执行上下文
  const ctx: ExecutionContext = {
    executionId: execId,
    jobId: job.id,
    jobName: job.name,
    traceId: execution.traceId ?? traceId,
    startTime,
    process: null,
    heartbeatTimer: null,
    softTimeoutTimer: null,
    hardTimeoutTimer: null,
    logBuffer: [],
    isCompleted: false,
    isHardKilled: false,
  };

  activeExecutions.set(execId, ctx);

  // 记录超时配置日志
  repo.appendLog(
    execId,
    "info",
    `Hard timeout set to ${hardTimeoutMs / 1000}s (${hardTimeoutMs / 60000}min)`,
  );

  try {
    // 根据负载类型执行
    let result: ExecutionResult;

    if (job.payload.kind === "systemEvent") {
      result = await executeSystemEvent(ctx, job);
    } else if (job.payload.kind === "agentTurn") {
      result = await executeAgentTurn(ctx, job, hardTimeoutMs);
    } else {
      result = {
        status: "failed",
        error: `Unknown payload kind: ${(job.payload as { kind: string }).kind}`,
        durationMs: Date.now() - startTime,
      };
    }

    // 记录执行日志
    repo.appendLog(
      execId,
      "info",
      `Execution completed with status: ${result.status}`,
    );

    // 刷新日志缓冲区
    repo.flushLogs();

    // 更新执行记录
    const now = Date.now();
    repo.updateExecutionStatus(execId, {
      status: result.status,
      finishedAt: now,
      errorStack: result.errorStack,
      errorMessage: result.error,
      resultJson: result.output
        ? JSON.stringify({ output: result.output })
        : null,
      durationMs: result.durationMs ?? now - startTime,
    });

    return result;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;

    console.error(`[Executor] Execution ${execId} failed:`, errorMsg);

    // 记录错误日志
    repo.appendLog(execId, "error", `Execution failed: ${errorMsg}`);
    repo.flushLogs();

    // 更新执行记录
    repo.updateExecutionStatus(execId, {
      status: "failed",
      finishedAt: Date.now(),
      errorMessage: errorMsg.substring(0, MAX_ERROR_LENGTH),
      errorStack,
      durationMs: Date.now() - startTime,
    });

    return {
      status: "failed",
      error: errorMsg,
      errorStack,
      durationMs: Date.now() - startTime,
    };
  } finally {
    // 清理执行上下文
    cleanupExecutionContext(ctx);
    activeExecutions.delete(execId);
  }
}

// ============================================================================
// Agent 执行
// ============================================================================

/**
 * 执行 Agent Turn（通过 opencode run）
 *
 * @param ctx - 执行上下文
 * @param job - 任务定义
 * @param hardTimeoutMs - 硬超时时间（毫秒）
 */
async function executeAgentTurn(
  ctx: ExecutionContext,
  job: CronJob,
  hardTimeoutMs: number,
): Promise<ExecutionResult> {
  const repo = getRepository();
  const startTime = ctx.startTime;
  const message = job.payload.message;

  // 记录开始日志
  repo.appendLog(
    ctx.executionId,
    "info",
    `Starting agent turn with message: ${message.substring(0, 100)}...`,
  );

  return new Promise((resolve) => {
    const args = ["run", message];

    // 启动子进程
    const proc = spawn(OPENCODE_COMMAND, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        // 传递执行上下文
        MCP_CRON_EXECUTION_ID: ctx.executionId,
        MCP_CRON_JOB_ID: ctx.jobId,
        MCP_CRON_TRACE_ID: ctx.traceId,
      },
    });

    ctx.process = proc;

    // ============================================================
    // 启动鲁棒性心跳（递归 setTimeout 模式）
    // ============================================================
    startResilientHeartbeat(ctx);

    // ============================================================
    // 启动硬超时定时器（强制 SIGKILL 保护）
    // ============================================================
    ctx.hardTimeoutTimer = setTimeout(() => {
      handleHardTimeout(ctx, resolve, hardTimeoutMs);
    }, hardTimeoutMs);

    // 记录硬超时设置
    console.error(
      `[Executor] ${ctx.executionId}: Hard timeout timer set for ${hardTimeoutMs / 1000}s`,
    );

    let stdout = "";
    let stderr = "";
    let lastFlushTime = Date.now();

    // 处理标准输出（流式日志）
    proc.stdout?.on("data", (data: Buffer) => {
      const chunk = data.toString();
      stdout += chunk;

      // 流式写入日志
      appendStreamLog(ctx, "stream", chunk);

      // 定期刷新日志缓冲
      if (Date.now() - lastFlushTime > LOG_FLUSH_INTERVAL_MS) {
        repo.flushLogs();
        lastFlushTime = Date.now();
      }
    });

    // 处理标准错误
    proc.stderr?.on("data", (data: Buffer) => {
      const chunk = data.toString();
      stderr += chunk;

      // 错误日志
      appendStreamLog(ctx, "error", chunk);
    });

    // ============================================================
    // 进程正常结束处理
    // ============================================================
    proc.on("close", (code) => {
      // 如果已被硬超时处理，则跳过
      if (ctx.isCompleted) {
        console.error(
          `[Executor] ${ctx.executionId}: close event received but already completed (hardKilled=${ctx.isHardKilled})`,
        );
        return;
      }

      ctx.isCompleted = true;
      const durationMs = Date.now() - startTime;

      // 清除硬超时定时器（防止内存泄漏）
      if (ctx.hardTimeoutTimer) {
        clearTimeout(ctx.hardTimeoutTimer);
        ctx.hardTimeoutTimer = null;
        console.error(
          `[Executor] ${ctx.executionId}: Hard timeout timer cleared on normal exit`,
        );
      }

      // 最终刷新日志
      repo.appendLog(
        ctx.executionId,
        "info",
        `Process exited with code: ${code}`,
      );
      repo.flushLogs();

      if (code === 0) {
        resolve({
          status: "success",
          output: truncateOutput(stdout),
          durationMs,
        });
      } else {
        resolve({
          status: "failed",
          error: truncateError(stderr) || `Process exited with code: ${code}`,
          output: truncateOutput(stdout + stderr),
          durationMs,
        });
      }
    });

    // 进程错误处理
    proc.on("error", (err) => {
      if (ctx.isCompleted) return;

      ctx.isCompleted = true;

      // 清除硬超时定时器
      if (ctx.hardTimeoutTimer) {
        clearTimeout(ctx.hardTimeoutTimer);
        ctx.hardTimeoutTimer = null;
      }

      repo.appendLog(ctx.executionId, "error", `Process error: ${err.message}`);
      repo.flushLogs();

      resolve({
        status: "failed",
        error: err.message,
        durationMs: Date.now() - startTime,
      });
    });
  });
}

// ============================================================================
// System Event 执行
// ============================================================================

/**
 * 执行系统事件
 * 真正执行 Shell 命令，而不是只记录日志
 */
async function executeSystemEvent(
  ctx: ExecutionContext,
  job: CronJob,
): Promise<ExecutionResult> {
  const repo = getRepository();
  const startTime = Date.now();

  // 1. 获取命令内容
  const command =
    typeof job.payload.message === "string"
      ? job.payload.message
      : JSON.stringify(job.payload);

  repo.appendLog(
    ctx.executionId,
    "info",
    `Starting system event command: ${command}`,
  );
  repo.flushLogs();

  try {
    // 2. 执行命令
    const { stdout, stderr } = await execAsync(command, {
      timeout: job.config?.maxDurationMs ?? DEFAULT_HARD_TIMEOUT_MS,
      env: process.env,
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer
    });

    const durationMs = Date.now() - startTime;

    // 3. 记录输出
    if (stdout) {
      repo.appendLog(ctx.executionId, "stream", stdout);
    }
    if (stderr) {
      // 有些命令会把信息输出到 stderr 但不代表失败，这里先记录
      repo.appendLog(ctx.executionId, "warn", stderr);
    }
    repo.flushLogs();

    return {
      status: "success",
      output: stdout || "Command executed successfully (no output)",
      durationMs,
    };
  } catch (error: any) {
    const durationMs = Date.now() - startTime;
    const errorMsg = error.message || "Unknown system event error";

    repo.appendLog(
      ctx.executionId,
      "error",
      `System event failed: ${errorMsg}`,
    );
    if (error.stdout) repo.appendLog(ctx.executionId, "stream", error.stdout);
    if (error.stderr) repo.appendLog(ctx.executionId, "error", error.stderr);
    repo.flushLogs();

    return {
      status: "failed",
      error: errorMsg,
      output: error.stdout || "",
      durationMs,
    };
  }
}

// ============================================================================
// 鲁棒性心跳（递归 setTimeout 模式）
// ============================================================================

/**
 * 启动鲁棒性心跳
 *
 * 使用递归 setTimeout 替代 setInterval，确保：
 * 1. 单次心跳失败不会中断后续心跳
 * 2. 心跳之间不会重叠
 * 3. 只有 isCompleted 为 true 时才停止
 */
function startResilientHeartbeat(ctx: ExecutionContext): void {
  console.error(
    `[Executor] ${ctx.executionId}: Starting resilient heartbeat (interval: ${HEARTBEAT_INTERVAL_MS}ms)`,
  );

  const scheduleNextHeartbeat = (): void => {
    // 检查是否应该停止心跳
    if (ctx.isCompleted) {
      console.error(
        `[Executor] ${ctx.executionId}: Heartbeat stopped (execution completed)`,
      );
      ctx.heartbeatTimer = null;
      return;
    }

    // 预约下一次心跳
    ctx.heartbeatTimer = setTimeout(() => {
      performHeartbeat(ctx);
      // 无论成功或失败，继续调度下一次心跳
      scheduleNextHeartbeat();
    }, HEARTBEAT_INTERVAL_MS);
  };

  // 立即执行第一次心跳
  performHeartbeat(ctx);
  // 开始调度循环
  scheduleNextHeartbeat();
}

/**
 * 执行单次心跳
 *
 * 容错处理：失败时仅记录警告，不抛异常
 */
function performHeartbeat(ctx: ExecutionContext): void {
  const repo = getRepository();

  try {
    const success = repo.updateHeartbeat(ctx.executionId);

    if (success) {
      // 成功：记录调试日志
      console.error(
        `[Executor] ${ctx.executionId}: Heartbeat updated successfully`,
      );
    } else {
      // 返回 false 通常意味着执行已不在 running 状态
      console.warn(
        `[Executor] ${ctx.executionId}: Heartbeat update returned false (execution may have changed status)`,
      );
    }
  } catch (error) {
    // 失败：仅记录警告，绝不抛异常，确保定时器链条不中断
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.warn(
      `[Executor] ${ctx.executionId}: Heartbeat update failed (will retry): ${errorMsg}`,
    );

    // 不设置 ctx.isCompleted，允许下次重试
  }
}

// ============================================================================
// 硬超时处理
// ============================================================================

/**
 * 处理硬超时 - 强制 SIGKILL
 *
 * 当子进程在硬超时时间后仍未退出时，强制杀死进程
 */
function handleHardTimeout(
  ctx: ExecutionContext,
  resolve: (result: ExecutionResult) => void,
  timeoutMs: number,
): void {
  // 检查是否已完成
  if (ctx.isCompleted) {
    console.error(
      `[Executor] ${ctx.executionId}: Hard timeout triggered but execution already completed`,
    );
    return;
  }

  console.error(
    `[Executor] ${ctx.executionId}: HARD TIMEOUT reached (${timeoutMs / 1000}s), forcing SIGKILL`,
  );

  ctx.isCompleted = true;
  ctx.isHardKilled = true;

  const repo = getRepository();
  repo.appendLog(
    ctx.executionId,
    "error",
    `HARD TIMEOUT: Process killed after ${timeoutMs / 1000}s (SIGKILL)`,
  );
  repo.flushLogs();

  // 强制杀死进程
  if (ctx.process) {
    try {
      // 直接使用 SIGKILL，不等待优雅退出
      ctx.process.kill("SIGKILL");
      console.error(
        `[Executor] ${ctx.executionId}: Process killed with SIGKILL`,
      );
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(
        `[Executor] ${ctx.executionId}: Failed to kill process: ${errorMsg}`,
      );
    }
  }

  // 立即返回结果（不等待 close 事件）
  resolve({
    status: "failed",
    error: `Execution hard timeout after ${timeoutMs / 1000}s (process killed with SIGKILL)`,
    durationMs: Date.now() - ctx.startTime,
  });
}

/**
 * 清理执行上下文
 */
function cleanupExecutionContext(ctx: ExecutionContext): void {
  // 停止心跳（递归 setTimeout 模式）
  if (ctx.heartbeatTimer) {
    clearTimeout(ctx.heartbeatTimer);
    ctx.heartbeatTimer = null;
  }

  // 清除软超时计时器
  if (ctx.softTimeoutTimer) {
    clearTimeout(ctx.softTimeoutTimer);
    ctx.softTimeoutTimer = null;
  }

  // 清除硬超时计时器
  if (ctx.hardTimeoutTimer) {
    clearTimeout(ctx.hardTimeoutTimer);
    ctx.hardTimeoutTimer = null;
  }

  // 确保进程已终止
  if (ctx.process && !ctx.isCompleted) {
    try {
      ctx.process.kill("SIGTERM");
    } catch {
      // 忽略错误
    }
  }
}

/**
 * 追加流式日志
 */
function appendStreamLog(
  ctx: ExecutionContext,
  level: LogLevel,
  content: string,
): void {
  const repo = getRepository();

  // 分行处理
  const lines = content.split("\n");
  for (const line of lines) {
    if (line.trim()) {
      repo.appendLog(ctx.executionId, level, line);
    }
  }
}

/**
 * 截断输出
 */
function truncateOutput(output: string): string {
  if (output.length <= MAX_OUTPUT_LENGTH) {
    return output;
  }
  return output.substring(0, MAX_OUTPUT_LENGTH) + "\n... [truncated]";
}

/**
 * 截断错误信息
 */
function truncateError(error: string): string {
  if (error.length <= MAX_ERROR_LENGTH) {
    return error;
  }
  return error.substring(0, MAX_ERROR_LENGTH) + "... [truncated]";
}

// ============================================================================
// 结果应用（兼容旧版）
// ============================================================================

/**
 * 应用执行结果到任务状态
 * 用于更新任务的 nextRunAtMs 等字段
 */
export function applyJobResult(
  job: CronJob,
  result: CronJobResult | ExecutionResult,
  nowMs: number,
): { shouldDelete: boolean; updates: Partial<CronJob> } {
  const updates: Partial<CronJob> = {
    state: { ...job.state },
  };

  // 统一处理状态
  const isSuccess = result.status === "ok" || result.status === "success";
  const isError = result.status === "error" || result.status === "failed";

  updates.state!.runningAtMs = undefined;
  updates.state!.lastRunAtMs = nowMs;
  updates.state!.lastStatus = isSuccess ? "ok" : isError ? "error" : "skipped";
  updates.state!.lastDurationMs = result.durationMs;
  updates.state!.lastError = result.error;

  if (isError) {
    updates.state!.consecutiveErrors =
      (updates.state!.consecutiveErrors || 0) + 1;
  } else {
    updates.state!.consecutiveErrors = 0;
  }

  const shouldDelete = job.options?.deleteAfterRun && isSuccess;

  if (shouldDelete) {
    return { shouldDelete: true, updates };
  }

  // 计算下次执行时间
  if (job.schedule.kind === "at") {
    // 一次性任务
    updates.enabled = false;
    updates.state!.nextRunAtMs = undefined;
  } else if (isError && job.enabled) {
    // 错误退避
    const backoffMs = getErrorBackoffMs(updates.state!.consecutiveErrors || 1);
    const normalNext = computeNextRunAtMs(job.schedule, nowMs);
    updates.state!.nextRunAtMs = normalNext
      ? Math.max(normalNext, nowMs + backoffMs)
      : nowMs + backoffMs;
  } else if (job.enabled) {
    // 正常计算下次执行时间
    updates.state!.nextRunAtMs = computeNextRunAtMs(job.schedule, nowMs);
  } else {
    updates.state!.nextRunAtMs = undefined;
  }

  return { shouldDelete: false, updates };
}

// ============================================================================
// 僵尸任务检测
// ============================================================================

/**
 * 检测并处理僵尸任务
 * （长时间无心跳的 running 状态任务）
 *
 * @param timeoutMs - 超时阈值（默认 5 分钟）
 * @returns 被标记为 failed 的执行记录数量
 */
export function detectStaleExecutions(
  timeoutMs: number = 5 * 60 * 1000,
): number {
  const repo = getRepository();
  const staleExecutions = repo.getStaleExecutions(timeoutMs);

  let markedCount = 0;

  for (const exec of staleExecutions) {
    console.warn(`[Executor] Marking stale execution as failed: ${exec.id}`);

    repo.appendLog(
      exec.id,
      "error",
      `Execution marked as failed due to stale heartbeat (no heartbeat for ${timeoutMs / 1000}s)`,
    );
    repo.flushLogs();

    const updated = repo.transitionExecutionStatus(
      exec.id,
      "running",
      "failed",
      {
        finishedAt: Date.now(),
        errorMessage: `Execution timed out (no heartbeat for ${timeoutMs / 1000}s)`,
      },
    );

    if (updated) {
      markedCount++;
    }
  }

  return markedCount;
}

// ============================================================================
// 执行控制
// ============================================================================

/**
 * 取消执行
 */
export function cancelExecution(executionId: string, reason?: string): boolean {
  const ctx = activeExecutions.get(executionId);
  if (!ctx) {
    return false;
  }

  console.error(`[Executor] Cancelling execution: ${executionId}`);

  const repo = getRepository();
  repo.appendLog(
    executionId,
    "warn",
    `Execution cancelled: ${reason ?? "No reason provided"}`,
  );
  repo.flushLogs();

  // 标记为完成
  ctx.isCompleted = true;

  // 终止进程
  if (ctx.process) {
    try {
      ctx.process.kill("SIGTERM");
    } catch {
      // 忽略错误
    }
  }

  // 更新状态
  repo.transitionExecutionStatus(executionId, "running", "cancelled", {
    finishedAt: Date.now(),
    errorMessage: reason ?? "Cancelled by user",
  });

  return true;
}

/**
 * 暂停执行
 */
export function pauseExecution(executionId: string, reason?: string): boolean {
  const ctx = activeExecutions.get(executionId);
  if (!ctx) {
    return false;
  }

  const repo = getRepository();
  repo.appendLog(
    executionId,
    "info",
    `Execution paused: ${reason ?? "No reason provided"}`,
  );
  repo.flushLogs();

  // 更新状态为 paused
  return repo.transitionExecutionStatus(executionId, "running", "paused", {});
}

/**
 * 恢复执行
 */
export function resumeExecution(executionId: string): boolean {
  const repo = getRepository();
  const execution = repo.getExecution(executionId);

  if (!execution || execution.status !== "paused") {
    return false;
  }

  repo.appendLog(executionId, "info", "Execution resumed");
  repo.flushLogs();

  return repo.transitionExecutionStatus(executionId, "paused", "pending", {});
}

/**
 * 获取活跃执行数量
 */
export function getActiveExecutionCount(): number {
  return activeExecutions.size;
}

/**
 * 获取所有活跃执行 ID
 */
export function getActiveExecutionIds(): string[] {
  return Array.from(activeExecutions.keys());
}

/**
 * 关闭所有执行
 */
export function shutdownAll(): void {
  console.error("[Executor] Shutting down all executions...");

  for (const [id, ctx] of activeExecutions) {
    cancelExecution(id, "Server shutdown");
  }

  // 最终刷新日志
  const repo = getRepository();
  repo.flushLogs();
}
