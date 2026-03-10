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
export type ExecutionStatus = 'pending' | 'running' | 'success' | 'failed' | 'waiting_for_approval' | 'paused' | 'cancelled';
/**
 * 日志级别枚举
 */
export type LogLevel = 'info' | 'error' | 'warn' | 'debug' | 'stream';
/**
 * 审批状态枚举
 */
export type ApprovalStatus = 'pending' | 'approved' | 'rejected';
/**
 * 数据库管理类
 */
export declare class DatabaseManager {
    private db;
    private dbPath;
    constructor(config?: DatabaseConfig);
    /**
     * 确保数据库目录存在
     */
    private ensureDirectory;
    /**
     * 初始化数据库配置
     */
    private initialize;
    /**
     * 获取当前 journal 模式
     */
    private getJournalMode;
    /**
   * 执行数据库迁移
   * @throws {Error} 迁移失败时抛出错误，调用方应处理并决定是否退出进程
   */
    migrate(): void;
    /**
     * 获取当前 schema 版本
     */
    private getSchemaVersion;
    /**
     * 迁移到 V1 - 初始化所有表
     */
    private migrateToV1;
    /**
     * 获取数据库实例
     */
    getDatabase(): Database.Database;
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
    transaction<T>(fn: () => T): T;
    /**
     * 执行原始 SQL（用于调试）
     */
    exec(sql: string): void;
    /**
     * 准备语句
     */
    prepare<T extends unknown[] | {} = unknown[]>(sql: string): Database.Statement<T>;
    /**
     * 关闭数据库连接
     */
    close(): void;
    /**
     * 获取数据库统计信息
     */
    getStats(): {
        dbPath: string;
        journalMode: string;
        pageSize: number;
        pageCount: number;
        fileSize: number;
    };
    /**
     * 执行数据库健康检查
     */
    healthCheck(): {
        healthy: boolean;
        message: string;
    };
    /**
     * 清理过期数据
     */
    cleanup(olderThanDays?: number): {
        executionsDeleted: number;
        logsDeleted: number;
        approvalsDeleted: number;
    };
    /**
     * 执行 WAL Checkpoint
     */
    checkpoint(mode?: 'PASSIVE' | 'FULL' | 'RESTART' | 'TRUNCATE'): void;
}
/**
 * 迁移错误类
 */
export declare class MigrationError extends Error {
    readonly version?: number | undefined;
    readonly cause?: Error | undefined;
    constructor(message: string, version?: number | undefined, cause?: Error | undefined);
}
/**
 * 获取数据库单例实例
 * @throws {MigrationError} 数据库迁移失败时抛出
 */
export declare function getDatabase(config?: DatabaseConfig): DatabaseManager;
/**
 * 安全初始化数据库
 * 返回初始化结果而不是抛出异常
 */
export declare function initializeDatabase(config?: DatabaseConfig): {
    success: boolean;
    database?: DatabaseManager;
    error?: string;
};
/**
 * 关闭数据库连接
 */
export declare function closeDatabase(): void;
/**
 * 生成唯一 ID
 */
export declare function generateId(prefix?: string): string;
/**
 * 生成 Trace ID（用于链路追踪）
 */
export declare function generateTraceId(): string;
