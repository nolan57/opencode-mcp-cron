# AGENTS.md - MCP Cron Server 项目上下文

## 项目概述

MCP Cron Server 是一个基于 Model Context Protocol (MCP) 的定时任务调度服务。它提供 cron-like 的任务调度能力，与 OpenCode CLI 集成，允许用户通过自然语言或 MCP 工具管理定时任务。

### 核心功能
- 支持三种调度类型：一次性任务 (at)、间隔任务 (every)、cron 表达式
- JSON 文件持久化存储
- 错误自动退避重试
- 并发执行控制（最大 3 个并发）
- 执行日志记录

### 技术栈
- **运行时**: Node.js
- **语言**: TypeScript (ES2022, ESNext modules)
- **依赖**:
  - `@modelcontextprotocol/sdk` - MCP 协议实现
  - `croner` - Cron 表达式解析
  - `zod` - 数据验证

## 项目结构

```
opencode-mcp-cron/
├── package.json          # 项目配置
├── tsconfig.json         # TypeScript 配置
├── src/
│   ├── index.ts          # MCP 服务器入口点
│   ├── types.ts          # 类型定义
│   ├── store.ts          # 持久化存储
│   ├── schedule.ts       # 调度时间计算
│   ├── scheduler.ts      # 主调度器
│   └── executor.ts       # 任务执行引擎
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

## 核心模块说明

### 1. `index.ts` - MCP 服务器
- 实现 MCP Server，通过 stdio 通信
- 暴露 5 个工具：`cron_add`, `cron_list`, `cron_remove`, `cron_run`, `cron_status`
- 启动时自动初始化调度器

### 2. `types.ts` - 类型系统
核心类型：
- `CronSchedule` - 调度配置（at/every/cron）
- `CronPayload` - 任务负载（agentTurn/systemEvent）
- `CronJob` - 完整任务定义
- `CronJobState` - 运行时状态

### 3. `store.ts` - 存储层
- 存储位置: `~/.config/mcp-cron/jobs.json`
- 提供 CRUD 操作
- 简单的锁机制防止并发写入

### 4. `schedule.ts` - 调度计算
- `computeNextRunAtMs()` - 计算下次执行时间
- `isJobDue()` - 判断任务是否到期
- `formatNextRun()` - 格式化显示时间

### 5. `scheduler.ts` - 调度器
- 60 秒轮询检查到期任务
- 单例模式
- 管理任务生命周期

### 6. `executor.ts` - 执行引擎
- 通过 `opencode run` 执行任务
- 5 分钟超时限制
- 错误退避策略：30s → 1m → 5m → 15m → 60m
- 日志存储: `~/.local/share/mcp-cron/logs/`

## MCP 工具 API

### cron_add
添加定时任务
```typescript
{
  name: string,           // 任务名称
  description?: string,   // 任务描述
  schedule: {
    kind: 'at' | 'every' | 'cron',
    atMs?: number,        // 一次性任务时间戳
    everyMs?: number,     // 间隔毫秒数
    expr?: string,        // cron 表达式
    tz?: string           // 时区
  },
  payload: {
    kind: 'agentTurn' | 'systemEvent',
    message: string
  },
  options?: {
    deleteAfterRun?: boolean,
    maxRetries?: number
  }
}
```

### cron_list
列出所有任务
```typescript
{ includeDisabled?: boolean }
```

### cron_remove
删除任务
```typescript
{ jobId: string }
```

### cron_run
立即执行任务
```typescript
{ jobId: string }
```

### cron_status
获取调度器状态
```typescript
{} // 无参数
```

## 开发约定

### 代码风格
- 使用 ESNext 模块语法（ESM）
- 文件扩展名导入需包含 `.js`（TypeScript ESM 约定）
- 使用 `console.error` 输出日志（stdout 用于 MCP 通信）

### 错误处理
- MCP 工具返回 `{ error: string }` 表示错误
- 执行器捕获异常并返回 `CronJobResult`

### 环境变量
- `OPENCODE_COMMAND` - 自定义 opencode 命令路径（默认: `opencode`）

## Cron 表达式示例

| 表达式 | 说明 |
|--------|------|
| `0 8 * * *` | 每天早上 8:00 |
| `0 9 * * 1-5` | 工作日早上 9:00 |
| `0 18 * * 1-5` | 工作日下午 6:00 |
| `0 */2 * * *` | 每 2 小时 |
| `0 0 * * *` | 每天午夜 |

## 数据存储

- **任务数据**: `~/.config/mcp-cron/jobs.json`
- **执行日志**: `~/.local/share/mcp-cron/logs/<job-id>.log`

## 故障排查

1. 任务未执行：检查 `cron_status` 确认调度器运行状态
2. MCP 连接失败：验证配置路径和 `node dist/index.js` 可执行
3. 执行超时：默认 5 分钟超时，检查日志了解详情
