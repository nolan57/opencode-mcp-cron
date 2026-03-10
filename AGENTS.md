# AGENTS.md - MCP Cron Server 项目上下文

## 项目概述

MCP Cron Server 是一个基于 Model Context Protocol (MCP) 的定时任务调度服务。它提供 cron-like 的任务调度能力，与 OpenCode CLI 集成，允许用户通过自然语言或 MCP 工具管理定时任务。

### 核心功能
- 支持三种调度类型：一次性任务 (at)、间隔任务 (every)、cron 表达式
- **SQLite 持久化存储**（基于 better-sqlite3，支持 WAL 模式高并发读写）
- 执行状态机（pending → running → success/failed/waiting_for_approval/paused/cancelled）
- 审批系统（支持需要人工审批的任务）
- 心跳机制（检测僵尸任务）
- 日志缓冲区（批量写入避免阻塞事件循环）
- 错误自动退避重试
- 并发执行控制
- 执行日志记录

### 技术栈
- **运行时**: Node.js
- **语言**: TypeScript (ES2022, ESNext modules)
- **数据库**: SQLite (better-sqlite3)
- **依赖**:
  - `@modelcontextprotocol/sdk` - MCP 协议实现
  - `croner` - Cron 表达式解析
  - `zod` - 数据验证
  - `better-sqlite3` - SQLite 数据库

## 项目结构

```
opencode-mcp-cron/
├── package.json          # 项目配置
├── tsconfig.json         # TypeScript 配置
├── src/
│   ├── index.ts          # MCP 服务器入口点
│   ├── types.ts          # 类型定义
│   ├── database.ts       # SQLite 数据库管理
│   ├── repository.ts     # 数据访问层（含日志缓冲区）
│   ├── scheduler.ts       # 主调度器
│   ├── executor.ts       # 任务执行引擎
│   └── schedule.ts       # 调度时间计算
└── dist/                 # 编译输出目录
```

## 构建与运行

```bash
# 安装依赖
npm install

# 编译 TypeScript
npm run build

# 运行服务器
npm run start

# 开发模式（监听编译）
npm run dev
```

### MCP 配置示例

在 OpenCode 配置中添加：
```json
{
  "mcp": {
    "cron": {
      "type": "local",
      "command": ["node", "/path/to/opencode-mcp-cron/dist/index.js"],
      "enabled": true
    }
  }
}
```

### 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `MCP_CRON_DB_PATH` | 数据库存储路径 | `~/.local/share/mcp-cron/cron.db` |
| `OPENCODE_COMMAND` | 自定义 opencode 命令路径 | `opencode` |

## 核心模块说明

### 1. `index.ts` - MCP 服务器
- 实现 MCP Server，通过 stdio 通信
- 暴露 14 个工具：
  - **任务管理**: `cron_add`, `cron_list`, `cron_get`, `cron_update`, `cron_remove`, `cron_run`, `cron_status`
  - **审批管理**: `cron_get_approvals`, `cron_approve`, `cron_reject`
  - **日志与统计**: `cron_get_logs`, `cron_get_stats`, `cron_get_history`, `cron_list_executions`
- 启动时自动初始化调度器
- Cron 表达式预验证

### 2. `types.ts` - 类型系统
核心类型：
- `CronSchedule` - 调度配置（at/every/cron）
- `CronPayload` - 任务负载（agentTurn/systemEvent）
- `CronJob` - 完整任务定义
- `CronJobState` - 运行时状态
- `Execution` - 执行记录
- `Approval` - 审批记录
- `LogEntry` - 日志条目
- `ExecutionStatus` - 执行状态机

### 3. `database.ts` - SQLite 数据库管理
- 存储位置: `~/.local/share/mcp-cron/cron.db`（可通过 `MCP_CRON_DB_PATH` 环境变量配置）
- WAL 模式高并发读写
- 自动 Schema 迁移
- 事务支持
- 数据表：
  - `jobs` - 任务表
  - `executions` - 执行记录表
  - `logs` - 日志表
  - `approvals` - 审批表

### 4. `repository.ts` - 数据访问层
- Job CRUD 操作
- Execution 状态管理
- **日志缓冲区设计**：
  - 日志先 push 到队列
  - 每 500ms 或攒够 50 条批量事务写入
  - 任务结束时调用 flush() 强制刷新
- Approval 审批流程

### 5. `scheduler.ts` - 调度器
- 60 秒轮询检查到期任务
- 单例模式
- 管理任务生命周期
- 支持审批流程触发

### 6. `executor.ts` - 执行引擎
- 通过 `opencode run` 执行任务
- 默认 1 小时超时（可配置）
- 心跳更新机制
- 错误退避策略：30s → 1m → 5m → 15m → 60m

## MCP 工具 API

### 任务管理

#### cron_add
添加定时任务（含 Cron 表达式预验证）
```typescript
{
  name: string,           // 任务名称
  description?: string,   // 任务描述
  schedule: {
    kind: 'at' | 'every' | 'cron',
    atMs?: number,        // 一次性任务时间戳（毫秒）
    everyMs?: number,     // 间隔毫秒数
    expr?: string,        // cron 表达式，如 "0 8 * * *"
    tz?: string           // 时区，如 "Asia/Shanghai"
  },
  payload: {
    kind: 'agentTurn' | 'systemEvent',
    message: string,      // prompt 或消息内容
    deliver?: boolean,    // 是否投递结果
    channel?: string,     // 投递渠道
    to?: string,          // 投递目标
    model?: string        // 使用的模型
  },
  options?: {
    deleteAfterRun?: boolean,   // 执行后删除（一次性任务）
    maxRetries?: number,        // 最大重试次数
    timeoutMs?: number,         // 执行超时（毫秒），默认 3600000（1小时）
    requiresApproval?: boolean   // 是否需要人工审批
  }
}
```

#### cron_list
列出所有任务
```typescript
{ includeDisabled?: boolean, includeInactive?: boolean }
```

#### cron_get
获取单个任务详情
```typescript
{ jobId: string }
```

#### cron_update
更新任务配置
```typescript
{
  jobId: string,
  name?: string,
  description?: string,
  enabled?: boolean,
  schedule?: CronSchedule,
  payload?: CronPayload,
  options?: CronJobOptions
}
```

#### cron_remove
删除任务（软删除）
```typescript
{ jobId: string }
```

#### cron_run
立即执行任务
```typescript
{ jobId: string }
```

#### cron_status
获取调度器状态
```typescript
{}
```

### 审批管理

#### cron_get_approvals
获取待审批的任务列表
```typescript
{}
```

#### cron_approve
批准任务执行
```typescript
{ executionId: string, note?: string }
```

#### cron_reject
拒绝任务执行
```typescript
{ executionId: string, reason?: string }
```

### 日志与统计

#### cron_get_logs
获取执行日志（支持分页）
```typescript
{ executionId: string, limit?: number, offset?: number }
```

#### cron_get_stats
获取系统统计信息
```typescript
{}
```

#### cron_get_history
获取任务的执行历史记录
```typescript
{ jobId: string, limit?: number }
```

#### cron_list_executions
分页列出所有执行记录
```typescript
{ limit?: number, offset?: number }
```

## 执行状态机

```
pending → running → success
                → failed
                → waiting_for_approval → pending (approved)
                                      → failed (rejected)
                → paused → running
                → cancelled
```

## 开发约定

### 代码风格
- 使用 ESNext 模块语法（ESM）
- 文件扩展名导入需包含 `.js`（TypeScript ESM 约定）
- 使用 `console.error` 输出日志（stdout 用于 MCP 通信）

### 错误处理
- MCP 工具返回 `{ error: string }` 表示错误
- 执行器捕获异常并返回 `CronJobResult`

### 数据库注意事项
- better-sqlite3 是同步库，高频写入会阻塞 Node.js 事件循环
- 日志使用缓冲区批量写入（Repository 层实现）
- 不要在事务回调中执行耗时操作

## Cron 表达式示例

| 表达式 | 说明 |
|--------|------|
| `0 8 * * *` | 每天早上 8:00 |
| `0 9 * * 1-5` | 工作日早上 9:00 |
| `0 18 * * 1-5` | 工作日下午 6:00 |
| `0 */2 * * *` | 每 2 小时 |
| `0 0 * * *` | 每天午夜 |
| `*/5 * * * *` | 每 5 分钟 |

## 数据存储

- **数据库**: `~/.local/share/mcp-cron/cron.db`
- **日志**: 存储在 SQLite 的 `logs` 表中

## 故障排查

1. 任务未执行：检查 `cron_status` 确认调度器运行状态
2. MCP 连接失败：验证配置路径和 `node dist/index.js` 可执行
3. 执行超时：默认 1 小时超时，检查日志了解详情
4. 数据库问题：检查 `MCP_CRON_DB_PATH` 环境变量或默认路径权限

## 版本信息

- 当前版本: 2.0.0
- 架构升级: 从 JSON 文件存储迁移到 SQLite 存储