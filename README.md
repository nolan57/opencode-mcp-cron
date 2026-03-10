# MCP Cron Server

MCP Cron Server is a standalone scheduling service that provides cron-like job scheduling through the Model Context Protocol (MCP). It integrates with OpenCode, allowing users to manage scheduled tasks using natural language.

## Features

- **Three Schedule Types**: One-time (at), Interval (every), Cron Expression
- **SQLite Persistence**: WAL mode for high-concurrency read/write
- **Approval System**: Jobs can require manual approval before execution
- **Heartbeat Mechanism**: Automatic zombie task detection
- **Execution State Machine**: Complete state transitions (pending → running → success/failed/waiting_for_approval/paused/cancelled)
- **Automatic Error Backoff**: 30s → 1m → 5m → 15m → 60m
- **Concurrency Control**: Max 3 concurrent executions
- **Execution Logs**: Buffered logging to avoid blocking

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     OpenCode CLI                             │
│                         │                                    │
│         ┌───────────────┴───────────────┐                   │
│         ▼                               ▼                   │
│  ┌──────────────┐              ┌──────────────┐            │
│  │   MCP Client │              │    Skill     │            │
│  │   (14 tools) │              │  (mcp-cron)  │            │
│  └──────────────┘              └──────────────┘            │
└─────────────────────────────────────────────────────────────┘
          │ stdio
          ▼
┌─────────────────────────────────────────────────────────────┐
│                  MCP Cron Server                            │
│  ┌─────────────────────────────────────────────────────┐   │
│  │                  CronScheduler                       │   │
│  │  ┌─────────────┐  ┌─────────┐  ┌──────────────┐  │   │
│  │  │ Repository   │  │  Timer  │  │   Executor   │  │   │
│  │  │  (SQLite)   │  │(setTimeout)│ │(subprocess) │  │   │
│  │  │ +LogBuffer  │  └─────────┘  └──────────────┘  │   │
│  │  └─────────────┘                                    │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

## Project Structure

```
opencode-mcp-cron/
├── package.json              # Project configuration
├── tsconfig.json            # TypeScript configuration
└── src/
    ├── index.ts             # MCP server entry point
    ├── types.ts            # Type definitions
    ├── database.ts          # SQLite database management
    ├── repository.ts        # Data access layer (with log buffer)
    ├── scheduler.ts         # Scheduler
    ├── executor.ts          # Execution engine
    └── schedule.ts          # Schedule time calculation
```

## Type Definitions

### Schedule Types

```typescript
type CronSchedule =
  | { kind: 'at'; atMs: number }                    // One-time task
  | { kind: 'every'; everyMs: number; anchorMs?: number }  // Interval task
  | { kind: 'cron'; expr: string; tz?: string };     // Cron expression
```

### Payload Types

```typescript
type CronPayload = {
  kind: 'agentTurn' | 'systemEvent';
  message: string;           // Prompt or message content
  deliver?: boolean;         // Whether to deliver result
  channel?: string;         // Delivery channel
  to?: string;              // Delivery target
  model?: string;           // Model override
};
```

### Execution Status

```typescript
type ExecutionStatus = 
  | 'pending'              // Waiting to execute
  | 'running'              // Currently executing
  | 'success'              // Executed successfully
  | 'failed'               // Execution failed
  | 'waiting_for_approval' // Waiting for approval
  | 'paused'               // Paused
  | 'cancelled';          // Cancelled
```

## Core Components

### 1. Database (`database.ts`)

SQLite database management.

**Features:**
- WAL mode for high-concurrency read/write
- Automatic schema migration
- Prepared statement caching
- Location: `~/.local/share/mcp-cron/cron.db`

### 2. Repository (`repository.ts`)

Data access layer.

**Features:**
- Job/Execution/Log/Approval CRUD
- Log buffering (batch writes to avoid blocking)
- Atomic state transitions
- Prepared statements

### 3. Schedule (`schedule.ts`)

Schedule time calculation.

**Functions:**
```typescript
// Calculate next execution time
computeNextRunAtMs(schedule: CronSchedule, nowMs: number): number | undefined

// Format time for display
formatNextRun(nextRunAtMs: number | undefined): string
```

### 4. Scheduler (`scheduler.ts`)

Main scheduler.

**Features:**
- Dynamic sleep scheduling
- Batch rate limiting
- State machine driven
- Concurrency control
- Zombie task detection

### 5. Executor (`executor.ts`)

Job execution engine.

**Features:**
- Subprocess execution
- Streaming logs
- Heartbeat updates
- Timeout control
- Approval triggering

## MCP Tools

| Tool | Description |
|------|-------------|
| `cron_add` | Add a new scheduled job |
| `cron_list` | List all jobs |
| `cron_get` | Get job details |
| `cron_update` | Update a job |
| `cron_remove` | Delete a job |
| `cron_run` | Execute a job immediately |
| `cron_status` | Get scheduler status |
| `cron_get_approvals` | Get pending approvals |
| `cron_approve` | Approve execution |
| `cron_reject` | Reject execution |
| `cron_get_logs` | Get execution logs |
| `cron_get_stats` | Get system statistics |
| `cron_get_history` | Get execution history |
| `cron_list_executions` | List executions with pagination |

## Usage

### Build

```bash
cd ~/Documents/opencode-mcp-cron
npm install
npm run build
```

### Configuration

Add to OpenCode configuration:

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

## Cron Expression Examples

| Expression | Description |
|------------|-------------|
| `0 8 * * *` | Every day at 8:00 AM |
| `0 9 * * 1-5` | Weekdays at 9:00 AM |
| `0 18 * * 1-5` | Weekdays at 6:00 PM |
| `0 */2 * * *` | Every 2 hours |
| `0 0 * * *` | Daily at midnight |

## Data Storage

- **Database**: `~/.local/share/mcp-cron/cron.db`
- **Logs**: Stored in SQLite `logs` table

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `OPENCODE_COMMAND` | opencode command path | `opencode` |
| `MCP_CRON_DB_PATH` | Database path | `~/.local/share/mcp-cron/cron.db` |

## Troubleshooting

### Job Not Executing

1. Check scheduler status:
```bash
opencode run "use cron_status tool to check scheduler status"
```

2. List jobs:
```bash
opencode run "use cron_list tool to list all jobs"
```

3. Check execution logs:
```bash
opencode run "use cron_get_logs tool to view logs"
```

### MCP Server Connection Failed

1. Verify configuration path
2. Test server manually:
```bash
node ~/Documents/opencode-mcp-cron/dist/index.js
```

---

*Last updated: 2026-03-10*
