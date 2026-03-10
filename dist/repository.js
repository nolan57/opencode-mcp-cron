/**
 * MCP Cron Server - 数据访问层
 *
 * 基于 SQLite 的数据访问实现，包含：
 * - Job CRUD 操作
 * - Execution 状态管理
 * - 日志缓冲区 + 批量写入
 * - Approval 审批流程
 *
 * ⚠️ 日志缓冲区设计：
 * better-sqlite3 是同步库，高频日志写入会阻塞事件循环。
 * 本模块实现内存缓冲区：
 * - 日志先 push 到队列
 * - 每 500ms 或攒够 50 条批量事务写入
 * - 任务结束时调用 flush() 强制刷新
 *
 * @module repository
 */
import { getDatabase, generateId, generateTraceId, } from "./database.js";
const DEFAULT_LOG_BUFFER_CONFIG = {
    maxBufferSize: 1000, // 最大缓冲 1000 条
    flushIntervalMs: 500, // 500ms 刷新一次
    batchSize: 50, // 每批写入 50 条
};
/**
 * 日志缓冲区类
 * 收集日志并批量写入数据库，避免高频同步写入阻塞事件循环
 */
class LogBuffer {
    buffer = [];
    config;
    flushTimer = null;
    sequenceCounters = new Map();
    db;
    isFlushing = false;
    flushPromise = null;
    // 预处理语句
    insertLogStmt;
    insertManyLogsStmt;
    constructor(db, config = {}) {
        this.db = db;
        this.config = { ...DEFAULT_LOG_BUFFER_CONFIG, ...config };
        // 准备预处理语句
        this.insertLogStmt = this.db.prepare(`
      INSERT INTO logs (execution_id, timestamp, level, content, sequence_num, metadata_json)
      VALUES (@executionId, @timestamp, @level, @content, @sequenceNum, @metadataJson)
    `);
        this.insertManyLogsStmt = this.db.prepare(`
      INSERT INTO logs (execution_id, timestamp, level, content, sequence_num, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
        // 启动定时刷新
        this.startFlushTimer();
    }
    /**
     * 获取下一个序列号
     */
    getNextSequence(executionId) {
        let seq = this.sequenceCounters.get(executionId) ?? 0;
        seq += 1;
        this.sequenceCounters.set(executionId, seq);
        return seq;
    }
    /**
     * 添加日志到缓冲区
     */
    append(executionId, level, content, metadataJson) {
        const log = {
            executionId,
            timestamp: Date.now(),
            level,
            content,
            sequenceNum: this.getNextSequence(executionId),
            metadataJson,
        };
        this.buffer.push(log);
        // 如果缓冲区达到阈值，触发异步刷新
        if (this.buffer.length >= this.config.batchSize) {
            this.scheduleFlush();
        }
        // 防止缓冲区过大（内存保护）
        if (this.buffer.length >= this.config.maxBufferSize) {
            console.warn("[LogBuffer] Buffer overflow, forcing flush");
            this.flushSync();
        }
    }
    /**
     * 启动定时刷新
     */
    startFlushTimer() {
        if (this.flushTimer)
            return;
        this.flushTimer = setInterval(() => {
            if (this.buffer.length > 0) {
                this.scheduleFlush();
            }
        }, this.config.flushIntervalMs);
        // 不阻止进程退出
        if (this.flushTimer.unref) {
            this.flushTimer.unref();
        }
    }
    /**
     * 停止定时刷新
     */
    stopFlushTimer() {
        if (this.flushTimer) {
            clearInterval(this.flushTimer);
            this.flushTimer = null;
        }
    }
    /**
     * 调度异步刷新（避免在事件循环中直接执行）
     */
    scheduleFlush() {
        if (this.isFlushing)
            return;
        // 使用 setImmediate 在下一个事件循环迭代中执行
        setImmediate(() => this.flushAsync());
    }
    /**
     * 异步刷新（非阻塞）
     */
    async flushAsync() {
        if (this.isFlushing) {
            return this.flushPromise ?? Promise.resolve();
        }
        this.isFlushing = true;
        this.flushPromise = this.doFlush();
        try {
            await this.flushPromise;
        }
        finally {
            this.isFlushing = false;
            this.flushPromise = null;
        }
    }
    /**
     * 同步刷新（用于关键路径）
     */
    flushSync() {
        if (this.buffer.length === 0)
            return;
        const logs = this.buffer.splice(0, this.buffer.length);
        this.writeLogsInBatches(logs);
    }
    /**
     * 执行刷新
     */
    async doFlush() {
        if (this.buffer.length === 0)
            return;
        // 取出所有待写日志
        const logs = this.buffer.splice(0, this.buffer.length);
        // 批量写入
        this.writeLogsInBatches(logs);
    }
    /**
     * 分批写入日志（事务）
     */
    writeLogsInBatches(logs) {
        if (logs.length === 0)
            return;
        const batchSize = this.config.batchSize;
        for (let i = 0; i < logs.length; i += batchSize) {
            const batch = logs.slice(i, i + batchSize);
            try {
                const insertMany = this.db.transaction((items) => {
                    for (const log of items) {
                        this.insertManyLogsStmt.run(log.executionId, log.timestamp, log.level, log.content, log.sequenceNum, log.metadataJson ?? null);
                    }
                });
                insertMany(batch);
            }
            catch (error) {
                console.error("[LogBuffer] Batch write failed:", error);
                // 记录失败的日志数量
                console.error(`[LogBuffer] Lost ${batch.length} log entries`);
            }
        }
    }
    /**
     * 清空执行记录的序列号缓存
     */
    clearSequence(executionId) {
        this.sequenceCounters.delete(executionId);
    }
    /**
     * 获取缓冲区大小
     */
    get size() {
        return this.buffer.length;
    }
    /**
     * 销毁缓冲区
     */
    destroy() {
        this.stopFlushTimer();
        this.flushSync();
        this.buffer = [];
        this.sequenceCounters.clear();
    }
}
// ============================================================================
// Repository 类
// ============================================================================
/**
 * 数据访问层
 */
export class Repository {
    db;
    logBuffer;
    // 预处理语句 - Jobs
    insertJobStmt;
    updateJobStmt;
    getJobByIdStmt;
    listJobsStmt;
    listEnabledJobsStmt;
    deleteJobStmt;
    updateJobNextRunStmt;
    // 预处理语句 - Executions
    insertExecutionStmt;
    getExecutionByIdStmt;
    updateExecutionStatusStmt;
    updateExecutionHeartbeatStmt;
    listExecutionsByJobStmt;
    getRunningExecutionsStmt;
    getNextDueExecutionStmt;
    getRecentExecutionsStmt;
    listExecutionsStmt;
    getTotalExecutionsStmt;
    // 预处理语句 - Logs
    getLogsByExecutionStmt;
    getLogCountStmt;
    // 预处理语句 - Approvals
    insertApprovalStmt;
    getApprovalByExecutionStmt;
    updateApprovalStatusStmt;
    listPendingApprovalsStmt;
    // 预处理语句 - Stats
    getStatsStmt;
    constructor() {
        this.db = getDatabase().getDatabase();
        this.logBuffer = new LogBuffer(this.db);
        this.prepareStatements();
    }
    /**
     * 准备所有预处理语句
     */
    prepareStatements() {
        // Jobs
        this.insertJobStmt = this.db.prepare(`
      INSERT INTO jobs (id, name, description, enabled, schedule_json, payload_json, options_json, config_json, created_at, updated_at, next_run_at)
      VALUES (@id, @name, @description, @enabled, @scheduleJson, @payloadJson, @optionsJson, @configJson, @createdAt, @updatedAt, @nextRunAt)
    `);
        this.updateJobStmt = this.db.prepare(`
      UPDATE jobs SET
        name = @name,
        description = @description,
        enabled = @enabled,
        schedule_json = @scheduleJson,
        payload_json = @payloadJson,
        options_json = @optionsJson,
        config_json = @configJson,
        updated_at = @updatedAt,
        next_run_at = @nextRunAt
      WHERE id = @id
    `);
        this.getJobByIdStmt = this.db.prepare(`
      SELECT * FROM jobs WHERE id = ?
    `);
        this.listJobsStmt = this.db.prepare(`
      SELECT * FROM jobs ORDER BY created_at DESC
    `);
        this.listEnabledJobsStmt = this.db.prepare(`
      SELECT * FROM jobs WHERE enabled = 1 AND is_active = 1 ORDER BY next_run_at ASC
    `);
        this.deleteJobStmt = this.db.prepare(`
      UPDATE jobs SET is_active = 0, updated_at = ? WHERE id = ?
    `);
        this.updateJobNextRunStmt = this.db.prepare(`
      UPDATE jobs SET next_run_at = ?, updated_at = ? WHERE id = ?
    `);
        // Executions
        this.insertExecutionStmt = this.db.prepare(`
      INSERT INTO executions (id, job_id, status, trace_id, context_json, created_at, updated_at)
      VALUES (@id, @jobId, 'pending', @traceId, @contextJson, @createdAt, @updatedAt)
    `);
        this.getExecutionByIdStmt = this.db.prepare(`
      SELECT * FROM executions WHERE id = ?
    `);
        // 原子状态更新 - 使用 WHERE 条件防止竞态
        this.updateExecutionStatusStmt = this.db.prepare(`
      UPDATE executions SET
        status = @status,
        started_at = COALESCE(@startedAt, started_at),
        finished_at = COALESCE(@finishedAt, finished_at),
        error_message = @errorMessage,
        error_stack = @errorStack,
        result_json = @resultJson,
        duration_ms = @durationMs,
        retry_count = COALESCE(@retryCount, retry_count),
        updated_at = @updatedAt
      WHERE id = @id AND status != 'cancelled'
    `);
        this.updateExecutionHeartbeatStmt = this.db.prepare(`
      UPDATE executions SET last_heartbeat = ?, updated_at = ? WHERE id = ? AND status = 'running'
    `);
        this.listExecutionsByJobStmt = this.db.prepare(`
      SELECT * FROM executions WHERE job_id = ? ORDER BY created_at DESC LIMIT ?
    `);
        this.getRunningExecutionsStmt = this.db.prepare(`
      SELECT * FROM executions WHERE status = 'running' ORDER BY started_at ASC
    `);
        // 获取下一个待执行的任务
        this.getNextDueExecutionStmt = this.db.prepare(`
      SELECT e.*, j.schedule_json, j.payload_json, j.options_json
      FROM executions e
      JOIN jobs j ON e.job_id = j.id
      WHERE e.status = 'pending' AND j.enabled = 1 AND j.is_active = 1
      ORDER BY j.next_run_at ASC
      LIMIT 1
    `);
        this.getRecentExecutionsStmt = this.db.prepare(`
      SELECT * FROM executions 
      WHERE status IN ('success', 'failed') 
      ORDER BY finished_at DESC 
      LIMIT ?
    `);
        // 分页查询所有执行记录
        this.listExecutionsStmt = this.db.prepare(`
      SELECT e.*, j.name as job_name
      FROM executions e
      LEFT JOIN jobs j ON e.job_id = j.id
      ORDER BY e.created_at DESC
      LIMIT ? OFFSET ?
    `);
        this.getTotalExecutionsStmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM executions
    `);
        // Logs
        this.getLogsByExecutionStmt = this.db.prepare(`
      SELECT * FROM logs WHERE execution_id = ? ORDER BY sequence_num ASC LIMIT ? OFFSET ?
    `);
        this.getLogCountStmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM logs WHERE execution_id = ?
    `);
        // Approvals
        this.insertApprovalStmt = this.db.prepare(`
      INSERT INTO approvals (id, execution_id, status, request_message, request_context_json, created_at, updated_at)
      VALUES (@id, @executionId, 'pending', @requestMessage, @requestContextJson, @createdAt, @updatedAt)
    `);
        this.getApprovalByExecutionStmt = this.db.prepare(`
      SELECT * FROM approvals WHERE execution_id = ?
    `);
        this.updateApprovalStatusStmt = this.db.prepare(`
      UPDATE approvals SET
        status = @status,
        note = @note,
        resolved_by = @resolvedBy,
        resolved_at = @resolvedAt,
        updated_at = @updatedAt
      WHERE id = @id
    `);
        this.listPendingApprovalsStmt = this.db.prepare(`
      SELECT a.*, e.job_id, j.name as job_name
      FROM approvals a
      JOIN executions e ON a.execution_id = e.id
      JOIN jobs j ON e.job_id = j.id
      WHERE a.status = 'pending'
      ORDER BY a.created_at ASC
    `);
        // Stats
        this.getStatsStmt = this.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM jobs WHERE is_active = 1) as total_jobs,
        (SELECT COUNT(*) FROM jobs WHERE enabled = 1 AND is_active = 1) as active_jobs,
        (SELECT COUNT(*) FROM executions) as total_executions,
        (SELECT COUNT(*) FROM executions WHERE started_at > ?) as today_executions,
        (SELECT COUNT(*) FROM executions WHERE status = 'running') as running_executions,
        (SELECT COUNT(*) FROM approvals WHERE status = 'pending') as pending_approvals,
        (SELECT AVG(duration_ms) FROM executions WHERE status = 'success' AND duration_ms IS NOT NULL) as avg_duration,
        (SELECT 
          (SELECT COUNT(*) FROM executions WHERE status = 'failed') * 100.0
        / NULLIF((SELECT COUNT(*) FROM executions WHERE status IN ('success', 'failed')), 0)) as error_rate
    `);
    }
    // =========================================================================
    // Job CRUD
    // =========================================================================
    /**
     * 创建任务
     */
    createJob(input) {
        const now = Date.now();
        const id = generateId("job");
        const job = {
            id,
            name: input.name,
            description: input.description,
            enabled: input.enabled ?? true,
            schedule: input.schedule,
            payload: input.payload,
            options: input.options,
            createdAtMs: now,
            updatedAtMs: now,
            state: input.state ?? {},
        };
        this.db.transaction(() => {
            this.insertJobStmt.run({
                id: job.id,
                name: job.name,
                description: job.description ?? null,
                enabled: job.enabled ? 1 : 0,
                scheduleJson: JSON.stringify(job.schedule),
                payloadJson: JSON.stringify(job.payload),
                optionsJson: job.options ? JSON.stringify(job.options) : null,
                configJson: null,
                createdAt: job.createdAtMs,
                updatedAt: job.updatedAtMs,
                nextRunAt: job.state.nextRunAtMs ?? null,
            });
        })();
        return job;
    }
    /**
     * 更新任务
     */
    updateJob(id, patch) {
        const existing = this.getJob(id);
        if (!existing)
            return null;
        const now = Date.now();
        const updated = {
            ...existing,
            ...patch,
            updatedAtMs: now,
        };
        this.db.transaction(() => {
            this.updateJobStmt.run({
                id: updated.id,
                name: updated.name,
                description: updated.description ?? null,
                enabled: updated.enabled ? 1 : 0,
                scheduleJson: JSON.stringify(updated.schedule),
                payloadJson: JSON.stringify(updated.payload),
                optionsJson: updated.options ? JSON.stringify(updated.options) : null,
                configJson: null,
                updatedAt: updated.updatedAtMs,
                nextRunAt: updated.state?.nextRunAtMs ?? null,
            });
        })();
        return updated;
    }
    /**
     * 获取任务
     */
    getJob(id) {
        const row = this.getJobByIdStmt.get(id);
        if (!row)
            return null;
        return this.rowToJob(row);
    }
    /**
     * 列出所有任务
     */
    listJobs(includeInactive = false) {
        const rows = includeInactive
            ? this.listJobsStmt.all()
            : this.db
                .prepare("SELECT * FROM jobs WHERE is_active = 1 ORDER BY created_at DESC")
                .all();
        return rows.map((row) => this.rowToJob(row));
    }
    /**
     * 列出启用的任务
     */
    listEnabledJobs() {
        const rows = this.listEnabledJobsStmt.all();
        return rows.map((row) => this.rowToJob(row));
    }
    /**
     * 删除任务（软删除）
     */
    deleteJob(id) {
        const result = this.deleteJobStmt.run(Date.now(), id);
        return result.changes > 0;
    }
    /**
     * 更新任务下次执行时间
     */
    updateJobNextRun(id, nextRunAt) {
        this.updateJobNextRunStmt.run(nextRunAt, Date.now(), id);
    }
    /**
     * 将数据库行转换为 CronJob 对象
     */
    rowToJob(row) {
        return {
            id: row.id,
            name: row.name,
            description: row.description,
            enabled: Boolean(row.enabled),
            schedule: JSON.parse(row.schedule_json),
            payload: JSON.parse(row.payload_json),
            options: row.options_json
                ? JSON.parse(row.options_json)
                : undefined,
            createdAtMs: row.created_at,
            updatedAtMs: row.updated_at,
            state: {
                nextRunAtMs: row.next_run_at,
            },
        };
    }
    // =========================================================================
    // Execution CRUD
    // =========================================================================
    /**
     * 创建执行记录
     */
    createExecution(input) {
        const now = Date.now();
        const id = generateId("exec");
        const traceId = input.traceId ?? generateTraceId();
        this.db.transaction(() => {
            this.insertExecutionStmt.run({
                id,
                jobId: input.jobId,
                traceId,
                contextJson: input.contextJson ?? null,
                createdAt: now,
                updatedAt: now,
            });
        })();
        return {
            id,
            jobId: input.jobId,
            status: "pending",
            startedAt: null,
            finishedAt: null,
            lastHeartbeat: null,
            errorMessage: null,
            errorStack: null,
            contextJson: input.contextJson ?? null,
            resultJson: null,
            traceId,
            durationMs: null,
            retryCount: 0,
            createdAt: now,
            updatedAt: now,
        };
    }
    /**
     * 获取执行记录
     */
    getExecution(id) {
        const row = this.getExecutionByIdStmt.get(id);
        if (!row)
            return null;
        return this.rowToExecution(row);
    }
    /**
     * 更新执行状态（原子操作）
     */
    updateExecutionStatus(id, update) {
        const now = Date.now();
        const result = this.updateExecutionStatusStmt.run({
            id,
            status: update.status ?? null,
            startedAt: update.startedAt ?? null,
            finishedAt: update.finishedAt ?? null,
            errorMessage: update.errorMessage ?? null,
            errorStack: update.errorStack ?? null,
            resultJson: update.resultJson ?? null,
            durationMs: update.durationMs ?? null,
            retryCount: update.retryCount ?? null,
            updatedAt: now,
        });
        return result.changes > 0;
    }
    /**
     * 原子状态转换：仅当当前状态匹配时才更新
     * 用于防止竞态条件
     */
    transitionExecutionStatus(id, fromStatus, toStatus, additionalUpdate) {
        const now = Date.now();
        const result = this.db
            .prepare(`
      UPDATE executions SET
        status = ?,
        started_at = COALESCE(?, started_at),
        finished_at = COALESCE(?, finished_at),
        error_message = ?,
        result_json = ?,
        duration_ms = ?,
        updated_at = ?
      WHERE id = ? AND status = ?
    `)
            .run(toStatus, additionalUpdate?.startedAt ?? null, additionalUpdate?.finishedAt ?? null, additionalUpdate?.errorMessage ?? null, additionalUpdate?.resultJson ?? null, additionalUpdate?.durationMs ?? null, now, id, fromStatus);
        return result.changes > 0;
    }
    /**
     * 更新心跳
     */
    updateHeartbeat(id) {
        const now = Date.now();
        const result = this.updateExecutionHeartbeatStmt.run(now, now, id);
        return result.changes > 0;
    }
    /**
     * 列出任务的历史执行记录
     */
    listExecutionsByJob(jobId, limit = 50) {
        const rows = this.listExecutionsByJobStmt.all(jobId, limit);
        return rows.map((row) => this.rowToExecution(row));
    }
    /**
     * 获取正在运行的执行
     */
    getRunningExecutions() {
        const rows = this.getRunningExecutionsStmt.all();
        return rows.map((row) => this.rowToExecution(row));
    }
    /**
     * 获取下一个待执行的任务
     */
    getNextDueExecution() {
        const row = this.getNextDueExecutionStmt.get();
        if (!row)
            return null;
        return {
            execution: this.rowToExecution(row),
            job: this.rowToJob(row),
        };
    }
    /**
     * 获取最近完成的执行
     */
    getRecentExecutions(limit = 10) {
        const rows = this.getRecentExecutionsStmt.all(limit);
        return rows.map((row) => this.rowToExecution(row));
    }
    /**
     * 分页查询所有执行记录
     *
     * @param limit 每页数量，默认 20，最大 100
     * @param offset 偏移量，默认 0
     * @returns 执行记录列表、总数、是否有更多
     */
    listExecutions(limit = 20, offset = 0) {
        // 参数约束
        const safeLimit = Math.min(Math.max(1, limit), 100);
        const safeOffset = Math.max(0, offset);
        const rows = this.listExecutionsStmt.all(safeLimit, safeOffset);
        const totalRow = this.getTotalExecutionsStmt.get();
        const total = totalRow.count;
        const hasMore = safeOffset + rows.length < total;
        return {
            items: rows.map((row) => this.rowToExecution(row)),
            total,
            hasMore,
        };
    }
    /**
     * 获取执行记录总数
     */
    getTotalExecutionsCount() {
        const row = this.getTotalExecutionsStmt.get();
        return row.count;
    }
    /**
     * 检测僵尸任务（长时间无心跳的运行中任务）
     */
    getStaleExecutions(timeoutMs = 300000) {
        const cutoff = Date.now() - timeoutMs;
        const rows = this.db
            .prepare(`
      SELECT * FROM executions 
      WHERE status = 'running' 
      AND (last_heartbeat IS NULL AND started_at < ? OR last_heartbeat < ?)
    `)
            .all(cutoff, cutoff);
        return rows.map((row) => this.rowToExecution(row));
    }
    /**
     * 将数据库行转换为 Execution 对象
     */
    rowToExecution(row) {
        return {
            id: row.id,
            jobId: row.job_id,
            status: row.status,
            startedAt: row.started_at,
            finishedAt: row.finished_at,
            lastHeartbeat: row.last_heartbeat,
            errorMessage: row.error_message,
            errorStack: row.error_stack,
            contextJson: row.context_json,
            resultJson: row.result_json,
            traceId: row.trace_id,
            durationMs: row.duration_ms,
            retryCount: row.retry_count,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
        };
    }
    // =========================================================================
    // Logs (带缓冲区)
    // =========================================================================
    /**
     * 追加日志（缓冲写入）
     */
    appendLog(executionId, level, content, metadata) {
        this.logBuffer.append(executionId, level, content, metadata ? JSON.stringify(metadata) : undefined);
    }
    /**
     * 强制刷新日志缓冲区
     */
    flushLogs() {
        this.logBuffer.flushSync();
    }
    /**
     * 异步刷新日志缓冲区
     */
    async flushLogsAsync() {
        await this.logBuffer.flushAsync();
    }
    /**
     * 获取执行的日志（分页）
     */
    getLogsByExecution(executionId, limit = 100, offset = 0) {
        const countRow = this.getLogCountStmt.get(executionId);
        const total = countRow.count;
        const rows = this.getLogsByExecutionStmt.all(executionId, limit, offset);
        return {
            items: rows.map((row) => ({
                id: row.id,
                executionId: row.execution_id,
                timestamp: row.timestamp,
                level: row.level,
                content: row.content,
                sequenceNum: row.sequence_num,
                metadataJson: row.metadata_json,
            })),
            total,
            hasMore: offset + rows.length < total,
            cursor: rows.length > 0 ? rows[rows.length - 1].id : undefined,
        };
    }
    /**
     * 清除执行记录的日志序列缓存
     */
    clearLogSequence(executionId) {
        this.logBuffer.clearSequence(executionId);
    }
    /**
     * 获取日志缓冲区大小
     */
    getLogBufferSize() {
        return this.logBuffer.size;
    }
    // =========================================================================
    // Approvals
    // =========================================================================
    /**
     * 创建审批请求
     */
    createApproval(input) {
        const now = Date.now();
        const id = generateId("apr");
        this.db.transaction(() => {
            this.insertApprovalStmt.run({
                id,
                executionId: input.executionId,
                requestMessage: input.requestMessage ?? null,
                requestContextJson: input.requestContextJson ?? null,
                createdAt: now,
                updatedAt: now,
            });
        })();
        return {
            id,
            executionId: input.executionId,
            status: "pending",
            requestMessage: input.requestMessage ?? null,
            requestContextJson: input.requestContextJson ?? null,
            note: null,
            resolvedBy: null,
            resolvedAt: null,
            createdAt: now,
            updatedAt: now,
        };
    }
    /**
     * 获取执行的审批记录
     */
    getApprovalByExecution(executionId) {
        const row = this.getApprovalByExecutionStmt.get(executionId);
        if (!row)
            return null;
        return this.rowToApproval(row);
    }
    /**
     * 批准执行
     */
    approveExecution(executionId, note, resolvedBy) {
        const approval = this.getApprovalByExecution(executionId);
        if (!approval || approval.status !== "pending")
            return null;
        const now = Date.now();
        const updatedApproval = {
            ...approval,
            status: "approved",
            note: note ?? null,
            resolvedBy: resolvedBy ?? null,
            resolvedAt: now,
            updatedAt: now,
        };
        this.db.transaction(() => {
            this.updateApprovalStatusStmt.run({
                id: approval.id,
                status: "approved",
                note: note ?? null,
                resolvedBy: resolvedBy ?? null,
                resolvedAt: now,
                updatedAt: now,
            });
            // 将执行状态从 waiting_for_approval 改为 pending（待恢复执行）
            this.db
                .prepare(`
        UPDATE executions SET status = 'pending', updated_at = ? WHERE id = ? AND status = 'waiting_for_approval'
      `)
                .run(now, executionId);
        })();
        const execution = this.getExecution(executionId);
        if (!execution)
            return null;
        return { approval: updatedApproval, execution };
    }
    /**
     * 拒绝执行
     */
    rejectExecution(executionId, reason, resolvedBy) {
        const approval = this.getApprovalByExecution(executionId);
        if (!approval || approval.status !== "pending")
            return null;
        const now = Date.now();
        const updatedApproval = {
            ...approval,
            status: "rejected",
            note: reason ?? null,
            resolvedBy: resolvedBy ?? null,
            resolvedAt: now,
            updatedAt: now,
        };
        this.db.transaction(() => {
            this.updateApprovalStatusStmt.run({
                id: approval.id,
                status: "rejected",
                note: reason ?? null,
                resolvedBy: resolvedBy ?? null,
                resolvedAt: now,
                updatedAt: now,
            });
            // 将执行状态改为 failed
            this.db
                .prepare(`
        UPDATE executions SET status = 'failed', error_message = ?, finished_at = ?, updated_at = ? WHERE id = ? AND status = 'waiting_for_approval'
      `)
                .run(reason ?? "Rejected by user", now, now, executionId);
        })();
        const execution = this.getExecution(executionId);
        if (!execution)
            return null;
        return { approval: updatedApproval, execution };
    }
    /**
     * 列出待审批的请求
     */
    listPendingApprovals() {
        const rows = this.listPendingApprovalsStmt.all();
        return rows.map((row) => ({
            ...this.rowToApproval(row),
            jobId: row.job_id,
            jobName: row.job_name,
        }));
    }
    /**
     * 将数据库行转换为 Approval 对象
     */
    rowToApproval(row) {
        return {
            id: row.id,
            executionId: row.execution_id,
            status: row.status,
            requestMessage: row.request_message,
            requestContextJson: row.request_context_json,
            note: row.note,
            resolvedBy: row.resolved_by,
            resolvedAt: row.resolved_at,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
        };
    }
    // =========================================================================
    // Stats & Utilities
    // =========================================================================
    /**
     * 获取系统统计信息
     */
    getSystemStats() {
        const startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);
        const row = this.getStatsStmt.get(startOfDay.getTime());
        return {
            totalJobs: row.total_jobs,
            activeJobs: row.active_jobs,
            totalExecutions: row.total_executions,
            todayExecutions: row.today_executions,
            runningExecutions: row.running_executions,
            pendingApprovals: row.pending_approvals,
            avgDurationMs: row.avg_duration,
            errorRate: row.error_rate ?? 0,
        };
    }
    /**
     * 获取下一个唤醒时间
     */
    getNextWakeTime() {
        const row = this.db
            .prepare(`
      SELECT MIN(next_run_at) as next_wake FROM jobs WHERE enabled = 1 AND is_active = 1 AND next_run_at IS NOT NULL
    `)
            .get();
        return row.next_wake;
    }
    /**
     * 事务包装
     */
    transaction(fn) {
        return this.db.transaction(fn)();
    }
    /**
     * 销毁资源
     */
    destroy() {
        this.logBuffer.destroy();
    }
}
// 单例实例
let repoInstance = null;
/**
 * 获取 Repository 单例
 */
export function getRepository() {
    if (!repoInstance) {
        repoInstance = new Repository();
    }
    return repoInstance;
}
/**
 * 销毁 Repository
 */
export function destroyRepository() {
    if (repoInstance) {
        repoInstance.destroy();
        repoInstance = null;
    }
}
