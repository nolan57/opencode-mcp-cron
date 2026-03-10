/**
 * MCP Cron Server - MCP 接口入口
 * 
 * 提供以下 MCP Tools：
 * - cron_add: 添加定时任务（含 Cron 表达式预验证）
 * - cron_list: 列出所有任务
 * - cron_get: 获取单个任务详情
 * - cron_update: 更新任务
 * - cron_remove: 删除任务
 * - cron_run: 立即执行任务
 * - cron_status: 获取调度器状态
 * - cron_get_approvals: 获取待审批列表
 * - cron_approve: 批准执行
 * - cron_reject: 拒绝执行
 * - cron_get_logs: 获取执行日志
 * - cron_get_stats: 获取系统统计
 * - cron_get_history: 获取执行历史
 * - cron_list_executions: 分页列出所有执行记录
 * 
 * @module index
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { Cron } from 'croner';
import { getScheduler, destroyScheduler } from './scheduler.js';
import { closeDatabase } from './database.js';
import { formatNextRun } from './schedule.js';

// ============================================================================
// 常量定义
// ============================================================================

/** 分页默认限制 */
const DEFAULT_PAGE_LIMIT = 20;

/** 分页最大限制 */
const MAX_PAGE_LIMIT = 100;

// ============================================================================
// 验证工具
// ============================================================================

/**
 * 验证 Cron 表达式
 * 
 * @param expr Cron 表达式
 * @returns 验证结果：{ valid: true } 或 { valid: false, error: string }
 */
function validateCronExpression(expr: string): { valid: boolean; error?: string } {
  if (!expr || typeof expr !== 'string') {
    return { valid: false, error: 'Cron expression is required and must be a string' };
  }

  const trimmed = expr.trim();
  if (!trimmed) {
    return { valid: false, error: 'Cron expression cannot be empty' };
  }

  try {
    // 使用 croner 库尝试解析
    // croner 支持 5 字段 (分 时 日 月 周) 或 6 字段 (秒 分 时 日 月 周)
    const cron = new Cron(trimmed);
    
    // 检查是否能获取下一次执行时间
    const nextRun = cron.nextRun();
    if (!nextRun) {
      return { 
        valid: false, 
        error: `Invalid cron expression: '${trimmed}'. No valid future run time found. Example: '*/5 * * * *' (every 5 minutes)` 
      };
    }

    return { valid: true };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    
    // 友好化错误信息
    let friendlyError = errorMsg;
    if (errorMsg.includes('Invalid cron pattern')) {
      friendlyError = `Invalid cron syntax: '${trimmed}'. Expected format: '<minute> <hour> <day> <month> <weekday>'. Example: '0 8 * * *' (every day at 8:00)`;
    } else if (errorMsg.includes('out of range') || errorMsg.includes('Invalid field')) {
      friendlyError = `Cron field value out of range: '${trimmed}'. Minutes: 0-59, Hours: 0-23, Day: 1-31, Month: 1-12, Weekday: 0-6. Example: '30 14 * * 1-5' (2:30 PM on weekdays)`;
    }

    return { 
      valid: false, 
      error: `Invalid cron expression: ${friendlyError}` 
    };
  }
}

// ============================================================================
// MCP Server 配置
// ============================================================================

const server = new Server(
  {
    name: 'mcp-cron',
    version: '2.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// ============================================================================
// 工具定义
// ============================================================================

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      // --------------------------------------------------------------------
      // 任务管理
      // --------------------------------------------------------------------
      {
        name: 'cron_add',
        description: '添加定时任务。支持三种调度类型：at（一次性）、every（间隔）、cron（表达式）。Cron 表达式会在创建前进行语法验证。',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '任务名称' },
            description: { type: 'string', description: '任务描述（可选）' },
            schedule: {
              type: 'object',
              description: '调度配置',
              properties: {
                kind: { type: 'string', enum: ['at', 'every', 'cron'], description: '调度类型' },
                atMs: { type: 'number', description: '一次性任务：绝对时间戳（毫秒）' },
                everyMs: { type: 'number', description: '间隔任务：间隔毫秒数' },
                expr: { type: 'string', description: 'Cron任务：cron表达式，如 "0 8 * * *"' },
                tz: { type: 'string', description: '时区，如 "Asia/Shanghai"' },
              },
              required: ['kind']
            },
            payload: {
              type: 'object',
              description: '任务内容',
              properties: {
                kind: { type: 'string', enum: ['agentTurn', 'systemEvent'], description: '负载类型' },
                message: { type: 'string', description: 'prompt或消息内容' },
                deliver: { type: 'boolean', description: '是否投递结果' },
                channel: { type: 'string', description: '投递渠道' },
                to: { type: 'string', description: '投递目标' },
                model: { type: 'string', description: '使用的模型' },
              },
              required: ['kind', 'message']
            },
            options: {
              type: 'object',
              description: '任务选项',
              properties: {
                deleteAfterRun: { type: 'boolean', description: '执行后删除（一次性任务）' },
                maxRetries: { type: 'number', description: '最大重试次数' },
                timeoutMs: { type: 'number', description: '执行超时（毫秒），默认 3600000（1小时）' },
                requiresApproval: { type: 'boolean', description: '是否需要审批' },
              }
            }
          },
          required: ['name', 'schedule', 'payload']
        }
      },
      {
        name: 'cron_list',
        description: '列出所有定时任务',
        inputSchema: {
          type: 'object',
          properties: {
            includeDisabled: { type: 'boolean', description: '包含禁用的任务' },
            includeInactive: { type: 'boolean', description: '包含已删除的任务' }
          }
        }
      },
      {
        name: 'cron_get',
        description: '获取单个任务详情',
        inputSchema: {
          type: 'object',
          properties: {
            jobId: { type: 'string', description: '任务ID' }
          },
          required: ['jobId']
        }
      },
      {
        name: 'cron_update',
        description: '更新任务配置',
        inputSchema: {
          type: 'object',
          properties: {
            jobId: { type: 'string', description: '任务ID' },
            name: { type: 'string', description: '任务名称' },
            description: { type: 'string', description: '任务描述' },
            enabled: { type: 'boolean', description: '是否启用' },
            schedule: {
              type: 'object',
              description: '调度配置',
              properties: {
                kind: { type: 'string', enum: ['at', 'every', 'cron'] },
                atMs: { type: 'number' },
                everyMs: { type: 'number' },
                expr: { type: 'string' },
                tz: { type: 'string' },
              }
            },
            payload: {
              type: 'object',
              description: '任务内容',
              properties: {
                kind: { type: 'string', enum: ['agentTurn', 'systemEvent'] },
                message: { type: 'string' },
              }
            },
            options: {
              type: 'object',
              properties: {
                deleteAfterRun: { type: 'boolean' },
                maxRetries: { type: 'number' },
                timeoutMs: { type: 'number' },
                requiresApproval: { type: 'boolean' },
              }
            }
          },
          required: ['jobId']
        }
      },
      {
        name: 'cron_remove',
        description: '删除定时任务（软删除）',
        inputSchema: {
          type: 'object',
          properties: {
            jobId: { type: 'string', description: '任务ID' }
          },
          required: ['jobId']
        }
      },
      {
        name: 'cron_run',
        description: '立即执行定时任务（不等待调度）',
        inputSchema: {
          type: 'object',
          properties: {
            jobId: { type: 'string', description: '任务ID' }
          },
          required: ['jobId']
        }
      },
      {
        name: 'cron_status',
        description: '获取调度器状态和运行信息',
        inputSchema: {
          type: 'object',
          properties: {}
        }
      },
      // --------------------------------------------------------------------
      // 审批管理
      // --------------------------------------------------------------------
      {
        name: 'cron_get_approvals',
        description: '获取待审批的任务列表',
        inputSchema: {
          type: 'object',
          properties: {}
        }
      },
      {
        name: 'cron_approve',
        description: '批准任务执行（通过审批ID或执行ID）',
        inputSchema: {
          type: 'object',
          properties: {
            executionId: { type: 'string', description: '执行ID' },
            note: { type: 'string', description: '审批备注' }
          },
          required: ['executionId']
        }
      },
      {
        name: 'cron_reject',
        description: '拒绝任务执行',
        inputSchema: {
          type: 'object',
          properties: {
            executionId: { type: 'string', description: '执行ID' },
            reason: { type: 'string', description: '拒绝原因' }
          },
          required: ['executionId']
        }
      },
      // --------------------------------------------------------------------
      // 日志与统计
      // --------------------------------------------------------------------
      {
        name: 'cron_get_logs',
        description: '获取执行日志（支持分页）',
        inputSchema: {
          type: 'object',
          properties: {
            executionId: { type: 'string', description: '执行ID' },
            limit: { type: 'number', description: '返回数量限制（默认100）' },
            offset: { type: 'number', description: '偏移量（默认0）' }
          },
          required: ['executionId']
        }
      },
      {
        name: 'cron_get_stats',
        description: '获取系统统计信息（任务总数、今日执行次数、平均耗时等）',
        inputSchema: {
          type: 'object',
          properties: {}
        }
      },
      {
        name: 'cron_get_history',
        description: '获取任务的执行历史记录',
        inputSchema: {
          type: 'object',
          properties: {
            jobId: { type: 'string', description: '任务ID' },
            limit: { type: 'number', description: '返回数量限制（默认10）' }
          },
          required: ['jobId']
        }
      },
      {
        name: 'cron_list_executions',
        description: '分页列出所有执行记录。支持 limit 和 offset 参数，防止返回过多数据导致 Token 爆炸。',
        inputSchema: {
          type: 'object',
          properties: {
            limit: { 
              type: 'number', 
              description: '每页数量（默认20，最大100）',
              minimum: 1,
              maximum: 100
            },
            offset: { 
              type: 'number', 
              description: '偏移量（默认0）',
              minimum: 0
            }
          }
        }
      },
    ]
  };
});

// ============================================================================
// 工具处理器
// ============================================================================

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const scheduler = getScheduler();
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      // --------------------------------------------------------------------
      // 任务管理
      // --------------------------------------------------------------------
      case 'cron_add': {
        const inputArgs = args as {
          name: string;
          description?: string;
          schedule: Record<string, unknown>;
          payload: Record<string, unknown>;
          options?: Record<string, unknown>;
        };

        // Cron 表达式预验证
        if (inputArgs.schedule?.kind === 'cron') {
          const expr = inputArgs.schedule.expr as string | undefined;
          if (expr) {
            const validation = validateCronExpression(expr);
            if (!validation.valid) {
              console.error(`[MCP-Cron] Cron validation failed for '${expr}': ${validation.error}`);
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      success: false,
                      error: validation.error
                    }, null, 2)
                  }
                ]
              };
            }
            console.error(`[MCP-Cron] Cron expression '${expr}' validated successfully`);
          }
        }

        const job = scheduler.addJob({
          name: inputArgs.name,
          description: inputArgs.description,
          enabled: true,
          schedule: inputArgs.schedule as any,
          payload: inputArgs.payload as any,
          options: inputArgs.options as any,
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                job: {
                  id: job.id,
                  name: job.name,
                  description: job.description,
                  enabled: job.enabled,
                  schedule: job.schedule,
                  nextRun: formatNextRun(job.state.nextRunAtMs),
                }
              }, null, 2)
            }
          ]
        };
      }

      case 'cron_list': {
        const inputArgs = args as { includeDisabled?: boolean; includeInactive?: boolean };
        const jobs = scheduler.listJobs(inputArgs.includeInactive || false);

        const filteredJobs = inputArgs.includeDisabled
          ? jobs
          : jobs.filter(j => j.enabled);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                total: filteredJobs.length,
                jobs: filteredJobs.map(j => ({
                  id: j.id,
                  name: j.name,
                  description: j.description,
                  enabled: j.enabled,
                  schedule: j.schedule,
                  nextRun: formatNextRun(j.state.nextRunAtMs),
                  lastRun: j.state.lastRunAtMs ? new Date(j.state.lastRunAtMs).toISOString() : null,
                  lastStatus: j.state.lastStatus,
                  lastError: j.state.lastError,
                  consecutiveErrors: j.state.consecutiveErrors,
                }))
              }, null, 2)
            }
          ]
        };
      }

      case 'cron_get': {
        const inputArgs = args as { jobId: string };
        const job = scheduler.getJob(inputArgs.jobId);

        if (!job) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ error: 'Job not found' }) }],
            isError: true
          };
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                id: job.id,
                name: job.name,
                description: job.description,
                enabled: job.enabled,
                schedule: job.schedule,
                payload: job.payload,
                options: job.options,
                state: {
                  nextRun: formatNextRun(job.state.nextRunAtMs),
                  lastRun: job.state.lastRunAtMs ? new Date(job.state.lastRunAtMs).toISOString() : null,
                  lastStatus: job.state.lastStatus,
                  lastError: job.state.lastError,
                  lastDurationMs: job.state.lastDurationMs,
                  consecutiveErrors: job.state.consecutiveErrors,
                },
                createdAt: new Date(job.createdAtMs).toISOString(),
                updatedAt: new Date(job.updatedAtMs).toISOString(),
              }, null, 2)
            }
          ]
        };
      }

      case 'cron_update': {
        const inputArgs = args as {
          jobId: string;
          name?: string;
          description?: string;
          enabled?: boolean;
          schedule?: Record<string, unknown>;
          payload?: Record<string, unknown>;
          options?: Record<string, unknown>;
        };

        // Cron 表达式预验证（如果更新了 schedule）
        if (inputArgs.schedule?.kind === 'cron') {
          const expr = inputArgs.schedule.expr as string | undefined;
          if (expr) {
            const validation = validateCronExpression(expr);
            if (!validation.valid) {
              console.error(`[MCP-Cron] Cron validation failed for '${expr}': ${validation.error}`);
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      success: false,
                      error: validation.error
                    }, null, 2)
                  }
                ]
              };
            }
          }
        }

        const updated = scheduler.updateJob(inputArgs.jobId, {
          name: inputArgs.name,
          description: inputArgs.description,
          enabled: inputArgs.enabled,
          schedule: inputArgs.schedule as any,
          payload: inputArgs.payload as any,
          options: inputArgs.options as any,
        });

        if (!updated) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ error: 'Job not found' }) }],
            isError: true
          };
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                job: {
                  id: updated.id,
                  name: updated.name,
                  enabled: updated.enabled,
                  nextRun: formatNextRun(updated.state.nextRunAtMs),
                }
              }, null, 2)
            }
          ]
        };
      }

      case 'cron_remove': {
        const inputArgs = args as { jobId: string };
        const success = scheduler.removeJob(inputArgs.jobId);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ success, jobId: inputArgs.jobId })
            }
          ]
        };
      }

      case 'cron_run': {
        const inputArgs = args as { jobId: string };
        const result = await scheduler.runJobNow(inputArgs.jobId);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      }

      case 'cron_status': {
        const status = scheduler.getStatus();

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                ...status,
                nextWakeAt: status.nextWakeAtMs ? new Date(status.nextWakeAtMs).toISOString() : null,
                lastTickAt: status.lastTickAt ? new Date(status.lastTickAt).toISOString() : null,
                uptimeSeconds: Math.floor(status.uptimeMs / 1000),
              }, null, 2)
            }
          ]
        };
      }

      // --------------------------------------------------------------------
      // 审批管理
      // --------------------------------------------------------------------
      case 'cron_get_approvals': {
        const approvals = scheduler.getPendingApprovals();

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                total: approvals.length,
                approvals: approvals.map(a => ({
                  approvalId: a.approvalId,
                  executionId: a.executionId,
                  jobId: a.jobId,
                  jobName: a.jobName,
                  requestMessage: a.requestMessage,
                  createdAt: new Date(a.createdAt).toISOString(),
                }))
              }, null, 2)
            }
          ]
        };
      }

      case 'cron_approve': {
        const inputArgs = args as { executionId: string; note?: string };
        const result = scheduler.approveExecution(inputArgs.executionId, inputArgs.note);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      }

      case 'cron_reject': {
        const inputArgs = args as { executionId: string; reason?: string };
        const result = scheduler.rejectExecution(inputArgs.executionId, inputArgs.reason);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      }

      // --------------------------------------------------------------------
      // 日志与统计
      // --------------------------------------------------------------------
      case 'cron_get_logs': {
        const inputArgs = args as { executionId: string; limit?: number; offset?: number };
        const result = scheduler.getExecutionLogs(
          inputArgs.executionId,
          inputArgs.limit || 100,
          inputArgs.offset || 0
        );

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                executionId: inputArgs.executionId,
                total: result.total,
                hasMore: result.hasMore,
                logs: result.items.map(log => ({
                  timestamp: new Date(log.timestamp).toISOString(),
                  level: log.level,
                  content: log.content,
                  sequenceNum: log.sequenceNum,
                }))
              }, null, 2)
            }
          ]
        };
      }

      case 'cron_get_stats': {
        const status = scheduler.getStatus();
        const repo = (scheduler as any).repo;
        const stats = repo.getSystemStats();

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                jobs: {
                  total: stats.totalJobs,
                  active: stats.activeJobs,
                },
                executions: {
                  total: stats.totalExecutions,
                  today: stats.todayExecutions,
                  running: stats.runningExecutions,
                },
                performance: {
                  avgDurationMs: stats.avgDurationMs,
                  errorRate: stats.errorRate.toFixed(2) + '%',
                },
                approvals: {
                  pending: stats.pendingApprovals,
                },
                scheduler: {
                  running: status.running,
                  uptimeSeconds: Math.floor(status.uptimeMs / 1000),
                  activeExecutions: status.activeExecutions,
                }
              }, null, 2)
            }
          ]
        };
      }

      case 'cron_get_history': {
        const inputArgs = args as { jobId: string; limit?: number };
        const history = scheduler.getExecutionHistory(inputArgs.jobId, inputArgs.limit || 10);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                jobId: inputArgs.jobId,
                total: history.length,
                executions: history.map(exec => ({
                  id: exec.id,
                  status: exec.status,
                  startedAt: exec.startedAt ? new Date(exec.startedAt).toISOString() : null,
                  finishedAt: exec.finishedAt ? new Date(exec.finishedAt).toISOString() : null,
                  durationMs: exec.durationMs,
                  errorMessage: exec.errorMessage,
                  traceId: exec.traceId,
                }))
              }, null, 2)
            }
          ]
        };
      }

      case 'cron_list_executions': {
        const inputArgs = args as { limit?: number; offset?: number };
        
        // 参数约束
        const limit = Math.min(Math.max(1, inputArgs.limit || DEFAULT_PAGE_LIMIT), MAX_PAGE_LIMIT);
        const offset = Math.max(0, inputArgs.offset || 0);

        console.error(`[MCP-Cron] Listing executions: limit=${limit}, offset=${offset}`);

        const result = scheduler.listExecutions(limit, offset);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                total: result.total,
                limit,
                offset,
                hasMore: result.hasMore,
                executions: result.items.map(exec => ({
                  id: exec.id,
                  jobId: exec.jobId,
                  status: exec.status,
                  startedAt: exec.startedAt ? new Date(exec.startedAt).toISOString() : null,
                  finishedAt: exec.finishedAt ? new Date(exec.finishedAt).toISOString() : null,
                  durationMs: exec.durationMs,
                  errorMessage: exec.errorMessage,
                  traceId: exec.traceId,
                  retryCount: exec.retryCount,
                  createdAt: new Date(exec.createdAt).toISOString(),
                }))
              }, null, 2)
            }
          ]
        };
      }

      default:
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: `Unknown tool: ${name}` })
            }
          ],
          isError: true
        };
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[MCP-Cron] Tool ${name} error:`, errorMsg);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ success: false, error: errorMsg })
        }
      ],
      isError: true
    };
  }
});

// ============================================================================
// 主入口
// ============================================================================

async function main(): Promise<void> {
  // 优雅关闭处理
  const shutdown = () => {
    console.error('[MCP-Cron] Shutting down...');
    destroyScheduler();
    closeDatabase();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // 启动调度器
  const scheduler = getScheduler();
  scheduler.start();

  console.error('[MCP-Cron] Server starting...');

  // 连接 MCP 传输
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('[MCP-Cron] Server connected');
}

main().catch((error) => {
  console.error('[MCP-Cron] Fatal error:', error);
  process.exit(1);
});
