import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { getScheduler } from './scheduler.js';
import { formatNextRun } from './schedule.js';

const server = new Server(
  {
    name: 'mcp-cron',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'cron_add',
        description: '添加定时任务',
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
                kind: { type: 'string', enum: ['agentTurn', 'systemEvent'] },
                message: { type: 'string', description: 'prompt或消息内容' },
              },
              required: ['kind', 'message']
            },
            options: {
              type: 'object',
              properties: {
                deleteAfterRun: { type: 'boolean', description: '执行后删除（一次性任务）' },
                maxRetries: { type: 'number', description: '最大重试次数' }
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
            includeDisabled: { type: 'boolean', description: '包含禁用的任务' }
          }
        }
      },
      {
        name: 'cron_remove',
        description: '删除定时任务',
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
        description: '立即执行定时任务',
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
        description: '获取调度器状态',
        inputSchema: {
          type: 'object',
          properties: {}
        }
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const scheduler = getScheduler();
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'cron_add': {
        const inputArgs = args as {
          name: string;
          description?: string;
          schedule: any;
          payload: any;
          options?: any;
        };
        
        const job = scheduler.addJob({
          name: inputArgs.name,
          description: inputArgs.description,
          enabled: true,
          schedule: inputArgs.schedule,
          payload: inputArgs.payload,
          options: inputArgs.options,
          state: {}
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
                  nextRun: formatNextRun(job.state.nextRunAtMs)
                }
              }, null, 2)
            }
          ]
        };
      }

      case 'cron_list': {
        const inputArgs = args as { includeDisabled?: boolean };
        const jobs = scheduler.listJobs(inputArgs.includeDisabled || false);
        
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                jobs: jobs.map(j => ({
                  id: j.id,
                  name: j.name,
                  enabled: j.enabled,
                  schedule: j.schedule,
                  nextRun: formatNextRun(j.state.nextRunAtMs),
                  lastRun: j.state.lastRunAtMs ? new Date(j.state.lastRunAtMs).toISOString() : null,
                  lastStatus: j.state.lastStatus
                }))
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
              text: JSON.stringify(result)
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
              text: JSON.stringify(status, null, 2)
            }
          ]
        };
      }

      default:
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'Unknown tool' })
            }
          ],
          isError: true
        };
    }
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ error: String(error) })
        }
      ],
      isError: true
    };
  }
});

async function main() {
  const scheduler = getScheduler();
  scheduler.start();
  
  console.error('[MCP-Cron] Server starting...');
  
  const transport = new StdioServerTransport();
  await server.connect(transport);
  
  console.error('[MCP-Cron] Server connected');
}

main().catch(console.error);
