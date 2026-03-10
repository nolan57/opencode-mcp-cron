/**
 * MCP Cron Server - 数据库管理模块
 * 
 * 基于 better-sqlite3 的 SQLite 数据库管理，支持：
 * - WAL 模式高并发读写
 * - 自动 Schema 迁移
 * - 事务支持
 * 
 * ⚠️ 同步写入阻塞警告：
 * better-sqlite3 是同步库，高频写入会阻塞 Node.js 事件循环。
 * 
 * 解决方案（在 repository.ts 中实现）：
 * - 内存缓冲区：收集日志到队列
 * - 批量写入：每 500ms 或攒够 50 条，事务批量插入
 * - 非阻塞：调度器和其他操作不受日志写入影响
 * 
 * @module database
 */
import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { homedir, tmpdir } from 'os';

/**
 * 获取数据库存储路径
 * 优先级：环境变量 > 用户主目录 > 当前工作目录 > 临时目录
 */
function getDatabasePath(): string {
  // 1. 环境变量优先
  if (process.env.MCP_CRON_DB_PATH) {
    return process.env.MCP_CRON_DB_PATH;
  }

  // 2. 用户主目录
  const home = homedir();
  if (home && home !== '~') {
    return join(home, '.local', 'share', 'mcp-cron', 'cron.db');
  }

  // 3. 当前工作目录
  const cwd = process.cwd();
  if (cwd) {
    console.error('[Database] Warning: Using current working directory for database storage');
    return join(cwd, '.mcp-cron', 'cron.db');
  }

  // 4. 最后 fallback 到临时目录
  const tmp = tmpdir();
  console.error('[Database] Warning: Using temp directory for database storage. Data may not persist!');
  return join(tmp, 'mcp-cron', 'cron.db');
}

// 数据库默认存储路径
const DEFAULT_DB_PATH = getDatabasePath();

// Schema 版本号，用于迁移
const SCHEMA_VERSION = 1;

/**
 * 数据库初始化配置
 */
export interface DatabaseConfig {
  dbPath?: string;
  verbose?: boolean;
}

/**
 * 执行状态枚举
 */
export type ExecutionStatus =
  | 'pending'
  | 'running'
  | 'success'
  | 'failed'
  | 'waiting_for_approval'
  | 'paused'
  | 'cancelled';

/**
 * 日志级别枚举
 */
export type LogLevel = 'info' | 'error' | 'warn' | 'debug' | 'stream';

/**
 * 审批状态枚举
 */
export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

/**
 * 创建 jobs 表的 SQL
 */
const CREATE_JOBS_TABLE = `
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  schedule_json TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  options_json TEXT,
  config_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  next_run_at INTEGER,
  is_active INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_jobs_enabled ON jobs(enabled);
CREATE INDEX IF NOT EXISTS idx_jobs_next_run ON jobs(next_run_at) WHERE enabled = 1;
CREATE INDEX IF NOT EXISTS idx_jobs_active ON jobs(is_active);
`;

/**
 * 创建 executions 表的 SQL
 */
const CREATE_EXECUTIONS_TABLE = `
CREATE TABLE IF NOT EXISTS executions (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  started_at INTEGER,
  finished_at INTEGER,
  last_heartbeat INTEGER,
  error_message TEXT,
  error_stack TEXT,
  context_json TEXT,
  result_json TEXT,
  trace_id TEXT,
  duration_ms INTEGER,
  retry_count INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_executions_job_id ON executions(job_id);
CREATE INDEX IF NOT EXISTS idx_executions_status ON executions(status);
CREATE INDEX IF NOT EXISTS idx_executions_started ON executions(started_at);
CREATE INDEX IF NOT EXISTS idx_executions_trace ON executions(trace_id);
CREATE INDEX IF NOT EXISTS idx_executions_heartbeat ON executions(last_heartbeat) WHERE status = 'running';
`;

/**
 * 创建 logs 表的 SQL
 */
const CREATE_LOGS_TABLE = `
CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  execution_id TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  level TEXT NOT NULL DEFAULT 'info',
  content TEXT NOT NULL,
  sequence_num INTEGER NOT NULL,
  metadata_json TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
  FOREIGN KEY (execution_id) REFERENCES executions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_logs_execution_id ON logs(execution_id, sequence_num);
CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level);
`;

/**
 * 创建 approvals 表的 SQL
 */
const CREATE_APPROVALS_TABLE = `
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  request_message TEXT,
  request_context_json TEXT,
  note TEXT,
  resolved_by TEXT,
  resolved_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (execution_id) REFERENCES executions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_approvals_execution_id ON approvals(execution_id);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);
CREATE INDEX IF NOT EXISTS idx_approvals_pending ON approvals(status) WHERE status = 'pending';
`;

/**
 * 创建 schema_versions 表的 SQL
 */
const CREATE_SCHEMA_VERSIONS_TABLE = `
CREATE TABLE IF NOT EXISTS schema_versions (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL,
  description TEXT
);
`;

/**
 * 数据库管理类
 */
export class DatabaseManager {
  private db: Database.Database;
  private dbPath: string;

  constructor(config: DatabaseConfig = {}) {
    this.dbPath = config.dbPath || DEFAULT_DB_PATH;
    this.ensureDirectory();
    this.db = new Database(this.dbPath, {
      verbose: config.verbose ? console.log : undefined
    });
    this.initialize();
  }

  /**
   * 确保数据库目录存在
   */
  private ensureDirectory(): void {
    const dir = dirname(this.dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * 初始化数据库配置
   */
  private initialize(): void {
    // 启用 WAL 模式 - 支持高并发读写
    this.db.pragma('journal_mode = WAL');
    
    // 启用外键约束
    this.db.pragma('foreign_keys = ON');
    
    // 设置 busy timeout - 等待锁释放的最长时间（毫秒）
    this.db.pragma('busy_timeout = 5000');
    
    // 设置同步模式 - NORMAL 模式在 WAL 下是安全的，且性能更好
    this.db.pragma('synchronous = NORMAL');
    
    // 设置缓存大小 - 单位：页数，每页约 4KB
    this.db.pragma('cache_size = -64000'); // 256MB

    console.error(`[Database] Initialized at ${this.dbPath}`);
    console.error(`[Database] Journal mode: ${this.getJournalMode()}`);
  }

  /**
   * 获取当前 journal 模式
   */
  private getJournalMode(): string {
    const result = this.db.pragma('journal_mode', { simple: true }) as { journal_mode: string };
    return result.journal_mode;
  }

  /**
 * 执行数据库迁移
 * @throws {Error} 迁移失败时抛出错误，调用方应处理并决定是否退出进程
 */
migrate(): void {
    console.error('[Database] Starting migration...');

    // 获取当前版本
    let currentVersion: number;
    try {
      currentVersion = this.getSchemaVersion();
      console.error(`[Database] Current schema version: ${currentVersion}`);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error(`[Database] Failed to get schema version: ${errMsg}`);
      throw new Error(`Database migration failed: cannot read schema version - ${errMsg}`);
    }

    try {
      if (currentVersion < 1) {
        this.migrateToV1();
      }

      // 未来版本迁移可在此添加
      // if (currentVersion < 2) { this.migrateToV2(); }

      const finalVersion = this.getSchemaVersion();
      console.error(`[Database] Migration complete. Schema version: ${finalVersion}`);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : '';
      console.error(`[Database] Migration failed: ${errMsg}`);
      console.error(`[Database] Stack trace: ${stack}`);
      
      // 抛出特定错误，让调用方决定如何处理
      throw new Error(`Database migration failed: ${errMsg}`);
    }
  }

  /**
   * 获取当前 schema 版本
   */
  private getSchemaVersion(): number {
    // 确保 schema_versions 表存在
    this.db.exec(CREATE_SCHEMA_VERSIONS_TABLE);

    const row = this.db.prepare('SELECT MAX(version) as version FROM schema_versions').get() as { version: number | null };
    return row?.version ?? 0;
  }

  /**
   * 迁移到 V1 - 初始化所有表
   */
  private migrateToV1(): void {
    console.error('[Database] Migrating to schema version 1...');

    try {
      this.db.transaction(() => {
        // 创建所有表，按依赖顺序
        const tables = [
          { name: 'jobs', sql: CREATE_JOBS_TABLE },
          { name: 'executions', sql: CREATE_EXECUTIONS_TABLE },
          { name: 'logs', sql: CREATE_LOGS_TABLE },
          { name: 'approvals', sql: CREATE_APPROVALS_TABLE },
        ];

        for (const table of tables) {
          try {
            this.db.exec(table.sql);
            console.error(`[Database] Created/verified table: ${table.name}`);
          } catch (error) {
            throw new Error(`Failed to create table '${table.name}': ${error instanceof Error ? error.message : String(error)}`);
          }
        }

        // 记录版本
        try {
          this.db.prepare(`
            INSERT INTO schema_versions (version, applied_at, description)
            VALUES (?, ?, ?)
          `).run(SCHEMA_VERSION, Date.now(), 'Initial schema with jobs, executions, logs, approvals tables');
        } catch (error) {
          throw new Error(`Failed to record schema version: ${error instanceof Error ? error.message : String(error)}`);
        }
      })();

      console.error('[Database] Schema version 1 migration complete');
    } catch (error) {
      // 如果事务失败，重新抛出包含上下文的错误
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error(`[Database] Schema version 1 migration failed: ${errMsg}`);
      throw new Error(`V1 migration failed: ${errMsg}`);
    }
  }

  /**
   * 获取数据库实例
   */
  getDatabase(): Database.Database {
    return this.db;
  }

  /**
   * 执行事务
   * 
   * ⚠️ 重要警告：
   * 不要在事务回调中执行以下操作，会导致长时间占用数据库锁：
   * - 调用外部 API
   * - 执行子进程
   * - 执行耗时计算
   * - 等待 Promise（better-sqlite3 是同步的）
   * 
   * 正确做法：先执行耗时操作，再在事务中快速写入数据库
   */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /**
   * 执行原始 SQL（用于调试）
   */
  exec(sql: string): void {
    this.db.exec(sql);
  }

  /**
   * 准备语句
   */
  prepare<T = unknown>(sql: string): Database.Statement<T> {
    return this.db.prepare<T>(sql);
  }

  /**
   * 关闭数据库连接
   */
  close(): void {
    try {
      // 尝试执行 checkpoint，将 WAL 内容合并到主数据库
      this.db.pragma('wal_checkpoint(TRUNCATE)');
      this.db.close();
      console.error('[Database] Connection closed');
    } catch (error) {
      console.error('[Database] Error closing connection:', error);
    }
  }

  /**
   * 获取数据库统计信息
   */
  getStats(): {
    dbPath: string;
    journalMode: string;
    pageSize: number;
    pageCount: number;
    fileSize: number;
  } {
    const journalMode = this.getJournalMode();
    const pageSize = (this.db.pragma('page_size', { simple: true }) as { page_size: number }).page_size;
    const pageCount = (this.db.pragma('page_count', { simple: true }) as { page_count: number }).page_count;
    
    return {
      dbPath: this.dbPath,
      journalMode,
      pageSize,
      pageCount,
      fileSize: pageSize * pageCount
    };
  }

  /**
   * 执行数据库健康检查
   */
  healthCheck(): { healthy: boolean; message: string } {
    try {
      // 执行简单查询测试连接
      this.db.prepare('SELECT 1').get();
      
      // 检查核心表是否存在
      const tables = this.db.prepare(`
        SELECT name FROM sqlite_master 
        WHERE type='table' AND name IN ('jobs', 'executions', 'logs', 'approvals')
      `).all() as { name: string }[];

      const expectedTables = ['jobs', 'executions', 'logs', 'approvals'];
      const existingTables = tables.map(t => t.name);
      const missingTables = expectedTables.filter(t => !existingTables.includes(t));

      if (missingTables.length > 0) {
        return {
          healthy: false,
          message: `Missing tables: ${missingTables.join(', ')}`
        };
      }

      return {
        healthy: true,
        message: `Database healthy. Tables: ${existingTables.join(', ')}`
      };
    } catch (error) {
      return {
        healthy: false,
        message: `Health check failed: ${error}`
      };
    }
  }

  /**
   * 清理过期数据
   */
  cleanup(olderThanDays: number = 30): {
    executionsDeleted: number;
    logsDeleted: number;
    approvalsDeleted: number;
  } {
    const cutoffTime = Date.now() - (olderThanDays * 24 * 60 * 60 * 1000);
    
    return this.transaction(() => {
      // 删除旧的执行记录（不包括正在运行的）
      const executionsResult = this.db.prepare(`
        DELETE FROM executions 
        WHERE finished_at < ? 
        AND status NOT IN ('running', 'pending', 'waiting_for_approval', 'paused')
      `).run(cutoffTime);

      // 删除旧的审批记录
      const approvalsResult = this.db.prepare(`
        DELETE FROM approvals 
        WHERE resolved_at < ? AND status != 'pending'
      `).run(cutoffTime);

      // logs 会通过外键级联删除

      return {
        executionsDeleted: executionsResult.changes,
        logsDeleted: 0, // 通过级联删除，无法直接获取数量
        approvalsDeleted: approvalsResult.changes
      };
    });
  }

  /**
   * 执行 WAL Checkpoint
   */
  checkpoint(mode: 'PASSIVE' | 'FULL' | 'RESTART' | 'TRUNCATE' = 'PASSIVE'): void {
    this.db.pragma(`wal_checkpoint(${mode})`);
  }
}

// 单例实例
let dbInstance: DatabaseManager | null = null;

/**
 * 迁移错误类
 */
export class MigrationError extends Error {
  constructor(message: string, public readonly version?: number, public readonly cause?: Error) {
    super(message);
    this.name = 'MigrationError';
  }
}

/**
 * 获取数据库单例实例
 * @throws {MigrationError} 数据库迁移失败时抛出
 */
export function getDatabase(config?: DatabaseConfig): DatabaseManager {
  if (!dbInstance) {
    try {
      dbInstance = new DatabaseManager(config);
      dbInstance.migrate();
    } catch (error) {
      // 清理失败的实例
      dbInstance = null;
      
      if (error instanceof Error) {
        throw new MigrationError(
          `Database initialization failed: ${error.message}`,
          undefined,
          error
        );
      }
      throw new MigrationError(`Database initialization failed: ${String(error)}`);
    }
  }
  return dbInstance;
}

/**
 * 安全初始化数据库
 * 返回初始化结果而不是抛出异常
 */
export function initializeDatabase(config?: DatabaseConfig): {
  success: boolean;
  database?: DatabaseManager;
  error?: string;
} {
  try {
    const db = getDatabase(config);
    const health = db.healthCheck();
    
    if (!health.healthy) {
      return { success: false, error: health.message };
    }
    
    return { success: true, database: db };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    return { success: false, error: errMsg };
  }
}

/**
 * 关闭数据库连接
 */
export function closeDatabase(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

/**
 * 生成唯一 ID
 */
export function generateId(prefix: string = ''): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 9);
  return prefix ? `${prefix}_${timestamp}_${random}` : `${timestamp}_${random}`;
}

/**
 * 生成 Trace ID（用于链路追踪）
 */
export function generateTraceId(): string {
  const timestamp = Date.now().toString(16);
  const random = Array.from({ length: 16 }, () => 
    Math.floor(Math.random() * 16).toString(16)
  ).join('');
  return `tr_${timestamp}_${random}`;
}
