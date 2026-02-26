# MCP Cron Server - Design & Implementation Guide

## Overview

MCP Cron Server is a standalone scheduling service that provides cron-like job scheduling capabilities through the Model Context Protocol (MCP). It integrates with OpenCode to allow users to manage scheduled tasks using natural language.

## Architecture

### System Components

```
┌─────────────────────────────────────────────────────────────┐
│                     OpenCode CLI                             │
│                         │                                    │
│         ┌───────────────┴───────────────┐                   │
│         ▼                               ▼                   │
│  ┌──────────────┐              ┌──────────────┐            │
│  │   MCP Client │              │   Skill      │            │
│  │  (cron_add, │              │  (mcp-cron)  │            │
│  │   cron_list) │              └──────────────┘            │
│  └──────────────┘                                       │
│         │                                                │
└─────────┼────────────────────────────────────────────────┘
          │ stdio
          ▼
┌─────────────────────────────────────────────────────────────┐
│                  MCP Cron Server                            │
│  ┌─────────────────────────────────────────────────────┐  │
│  │                  CronScheduler                       │  │
│  │  ┌─────────┐  ┌─────────┐  ┌─────────────────────┐  │  │
│  │  │ Store   │  │ Timer   │  │    Executor        │  │  │
│  │  │ (JSON)  │  │ (setInterval)│ │ (child_process) │  │  │
│  │  └─────────┘  └─────────┘  └─────────────────────┘  │  │
│  └─────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
          │
          ▼ opencode run
┌─────────────────────────────────────────────────────────────┐
│                     OpenCode                                │
│  ┌──────────────┐                                          │
│  │    Skill     │ → qqbot_send → QQ/Notification          │
│  └──────────────┘                                          │
└─────────────────────────────────────────────────────────────┘
```

## Project Structure

```
~/Documents/opencode-mcp-cron/
├── package.json              # Project configuration
├── tsconfig.json            # TypeScript config
└── src/
    ├── index.ts             # MCP server entry point
    ├── types.ts             # Type definitions
    ├── store.ts             # Persistent storage
    ├── schedule.ts          # Cron expression parsing
    ├── scheduler.ts         # Main scheduler logic
    └── executor.ts          # Job execution engine
```

## Type Definitions (`types.ts`)

### Schedule Types

```typescript
// Three types of schedules supported
type CronSchedule =
  | { kind: 'at'; atMs: number }           // One-time task
  | { kind: 'every'; everyMs: number }      // Interval-based
  | { kind: 'cron'; expr: string; tz?: string }; // Cron expression
```

### Payload Types

```typescript
// Job payload determines how the task is executed
type CronPayloadKind = 'agentTurn' | 'systemEvent';

type CronPayload = {
  kind: CronPayloadKind;
  message: string;           // Prompt or message content
  deliver?: boolean;         // Whether to deliver result
  channel?: string;          // Target channel (e.g., 'qqbot')
  to?: string;               // Target recipient
  model?: string;            // Optional model override
};
```

### Job Definition

```typescript
type CronJob = {
  id: string;                // Unique job identifier
  name: string;              // Human-readable name
  description?: string;      // Optional description
  enabled: boolean;          // Whether job is active
  createdAtMs: number;      // Creation timestamp
  updatedAtMs: number;       // Last update timestamp
  schedule: CronSchedule;    // Scheduling configuration
  payload: CronPayload;      // What to execute
  options?: CronJobOptions;  // Execution options
  state: CronJobState;       // Runtime state
};

type CronJobOptions = {
  deleteAfterRun?: boolean;  // Delete after one-shot execution
  retry?: boolean;           // Enable retry on failure
  maxRetries?: number;       // Max retry attempts
};
```

## Core Components

### 1. Store (`store.ts`)

Responsible for persistent storage of cron jobs.

**Features:**
- JSON file-based storage
- Location: `~/.config/mcp-cron/jobs.json`
- Lock mechanism for concurrent access
- CRUD operations for jobs

**Key Methods:**
```typescript
class CronStore {
  getJobs(includeDisabled?: boolean): CronJob[]
  getJob(id: string): CronJob | undefined
  addJob(job: CronJob): CronJob
  updateJob(id: string, updates: Partial<CronJob>): CronJob | undefined
  removeJob(id: string): boolean
  getNextWakeTime(): number | null
  acquireLock(): Promise<boolean>
  releaseLock(): void
}
```

### 2. Schedule (`schedule.ts`)

Handles schedule computation using the `croner` library.

**Features:**
- Cron expression parsing
- One-time task (at) calculation
- Interval task (every) calculation
- Timezone support

**Key Functions:**
```typescript
// Calculate next execution time
computeNextRunAtMs(schedule: CronSchedule, nowMs: number): number | undefined

// Check if job is due
isJobDue(job: CronJob, nowMs: number): boolean

// Format next run for display
formatNextRun(nextRunAtMs: number | null): string
```

### 3. Scheduler (`scheduler.ts`)

Main scheduling engine that manages job lifecycle.

**Features:**
- Timer-based polling (every 60 seconds)
- Concurrent job execution (max 3)
- Automatic next-run computation
- Job state management

**Key Methods:**
```typescript
class CronScheduler {
  start(): void              // Start the scheduler
  stop(): void               // Stop the scheduler
  addJob(input: CronJobCreate): CronJob
  updateJob(id: string, patch: CronJobPatch): CronJob | undefined
  removeJob(id: string): boolean
  listJobs(includeDisabled?: boolean): CronJob[]
  getJob(id: string): CronJob | undefined
  getStatus(): CronStatus
  runJobNow(id: string, force?: boolean): Promise<Result>
}
```

### 4. Executor (`executor.ts`)

Handles actual job execution by spawning OpenCode processes.

**Features:**
- Spawns `opencode run` subprocess
- Captures stdout/stderr
- Timeout handling (5 minutes)
- Error backoff strategy
- Log file management

**Error Backoff Schedule:**
```typescript
const ERROR_BACKOFF_MS = [
  30_000,   // 1st error → 30 seconds
  60_000,   // 2nd error → 1 minute
  300_000,  // 3rd error → 5 minutes
  900_000,  // 4th error → 15 minutes
  3600_000  // 5th+ error → 60 minutes
];
```

### 5. MCP Server (`index.ts`)

Exposes cron functionality through MCP protocol.

**Available Tools:**

| Tool | Description |
|------|-------------|
| `cron_add` | Add a new scheduled job |
| `cron_list` | List all jobs |
| `cron_remove` | Delete a job |
| `cron_run` | Execute a job immediately |
| `cron_status` | Get scheduler status |

## MCP Tools Schema

### cron_add

```json
{
  "name": "cron_add",
  "description": "Add a new scheduled job",
  "inputSchema": {
    "type": "object",
    "properties": {
      "name": { "type": "string", "description": "Job name" },
      "description": { "type": "string", "description": "Optional description" },
      "schedule": {
        "type": "object",
        "properties": {
          "kind": { "type": "string", "enum": ["at", "every", "cron"] },
          "atMs": { "type": "number", "description": "One-time: absolute timestamp (ms)" },
          "everyMs": { "type": "number", "description": "Interval: interval in ms" },
          "expr": { "type": "string", "description": "Cron: cron expression" },
          "tz": { "type": "string", "description": "Timezone" }
        },
        "required": ["kind"]
      },
      "payload": {
        "type": "object",
        "properties": {
          "kind": { "type": "string", "enum": ["agentTurn", "systemEvent"] },
          "message": { "type": "string", "description": "Prompt or message" }
        },
        "required": ["kind", "message"]
      },
      "options": {
        "type": "object",
        "properties": {
          "deleteAfterRun": { "type": "boolean" },
          "maxRetries": { "type": "number" }
        }
      }
    },
    "required": ["name", "schedule", "payload"]
  }
}
```

### cron_list

```json
{
  "name": "cron_list",
  "description": "List all scheduled jobs",
  "inputSchema": {
    "type": "object",
    "properties": {
      "includeDisabled": { "type": "boolean", "description": "Include disabled jobs" }
    }
  }
}
```

### cron_remove

```json
{
  "name": "cron_remove",
  "description": "Remove a scheduled job",
  "inputSchema": {
    "type": "object",
    "properties": {
      "jobId": { "type": "string", "description": "Job ID to remove" }
    },
    "required": ["jobId"]
  }
}
```

### cron_run

```json
{
  "name": "cron_run",
  "description": "Execute a job immediately",
  "inputSchema": {
    "type": "object",
    "properties": {
      "jobId": { "type": "string", "description": "Job ID to run" }
    },
    "required": ["jobId"]
  }
}
```

### cron_status

```json
{
  "name": "cron_status",
  "description": "Get scheduler status",
  "inputSchema": {
    "type": "object",
    "properties": {}
  }
}
```

## Usage

### Installation

1. Build the project:
```bash
cd ~/Documents/opencode-mcp-cron
npm install
npm run build
```

2. Configure in OpenCode:
```json
{
  "mcp": {
    "cron": {
      "type": "local",
      "command": ["node", "/path/to/dist/index.js"],
      "enabled": true
    }
  }
}
```

3. Add Skill:
```bash
# Copy skill to ~/.config/opencode/skills/mcp-cron/
```

### Natural Language Commands

```
# Add one-time reminder (5 minutes later)
"5分钟后提醒我喝水"

# Add daily reminder
"每天早上9点提醒我打卡"

# Add weekday reminder
"每周一到周五下午6点提醒我下班"

# List all jobs
"查看所有定时任务"

# Remove a job
"取消喝水提醒"

# Run job immediately
"立即执行打卡提醒"
```

### Direct MCP Tool Usage

```bash
# Check status
opencode run "使用 cron_status 工具查看调度器状态"

# Add one-time task
opencode run '使用 cron_add 工具添加一次性任务，5分钟后提醒我喝水'

# Add cron task
opencode run '使用 cron_add 工具添加每天早上8点提醒我打卡的周期性任务'

# List jobs
opencode run "使用 cron_list 工具查看所有定时任务"

# Remove job
opencode run '使用 cron_remove 工具删除任务，jobId 是 job_xxx'
```

## Cron Expression Examples

| Expression | Description |
|------------|-------------|
| `0 8 * * *` | Every day at 8:00 AM |
| `0 9 * * 1-5` | Weekdays at 9:00 AM |
| `0 18 * * 1-5` | Weekdays at 6:00 PM |
| `0 9 * * 0,6` | Weekends at 9:00 AM |
| `0 */2 * * *` | Every 2 hours |
| `0 0 * * *` | Daily at midnight |

## Data Storage

### Job Storage
- **Location:** `~/.config/mcp-cron/jobs.json`
- **Format:** JSON file containing job definitions

### Execution Logs
- **Location:** `~/.local/share/mcp-cron/logs/`
- **Format:** One log file per job execution

## Comparison with OpenClaw Cron

| Feature | MCP Cron Server | OpenClaw Cron |
|---------|-----------------|---------------|
| Cron Expressions | ✅ | ✅ |
| One-time Tasks | ✅ | ✅ |
| Interval Tasks | ✅ | ✅ |
| Job Persistence | ✅ | ✅ |
| Error Retry | ✅ (manual) | ✅ (auto) |
| Agent Execution | `opencode run` | Built-in |
| Channel Integration | Via Skill | Built-in |
| Web UI | ❌ | ✅ |
| Webhook | ✅ (fetch) | ✅ |

## Extensibility

### Adding Notification Channels

To add QQ notification, modify the executor to call `qqbot_send` after job completion:

```typescript
// In executor.ts, after job completes
if (job.payload.deliver && job.payload.channel === 'qqbot') {
  spawn('opencode', ['run', `使用 qqbot_send 发送到 ${job.payload.to}，内容是：${result.output}`]);
}
```

### Custom Execution Modes

Add new payload kinds in `types.ts`:

```typescript
type CronPayload = {
  kind: 'agentTurn' | 'systemEvent' | 'webhook' | 'custom';
  // ... other fields
};
```

## Troubleshooting

### Job Not Executing

1. Check if scheduler is running:
```bash
opencode run "使用 cron_status 工具查看调度器状态"
```

2. Verify job is enabled:
```bash
opencode run "使用 cron_list 工具查看所有定时任务"
```

3. Check log files:
```bash
ls ~/.local/share/mcp-cron/logs/
cat ~/.local/share/mcp-cron/logs/<job-id>.log
```

### MCP Server Not Connecting

1. Verify MCP configuration in `opencode.json`
2. Test server manually:
```bash
node ~/Documents/opencode-mcp-cron/dist/index.js
```

3. Check OpenCode MCP list:
```bash
opencode mcp list
```

## Files Reference

- Main entry: `src/index.ts`
- Types: `src/types.ts`
- Storage: `src/store.ts`
- Scheduling: `src/scheduler.ts`
- Execution: `src/executor.ts`
- Schedule parsing: `src/schedule.ts`
- Skill guide: `~/.config/opencode/skills/mcp-cron/SKILL.md`

---

*Last updated: 2026-02-25*
