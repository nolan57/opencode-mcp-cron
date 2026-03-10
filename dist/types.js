/**
 * MCP Cron Server - 类型定义
 *
 * 包含所有核心类型定义，与数据库 Schema 保持一致
 *
 * @module types
 */
/**
 * 执行状态转换规则
 */
export const VALID_STATUS_TRANSITIONS = {
    pending: ['running', 'cancelled'],
    running: ['success', 'failed', 'waiting_for_approval', 'paused'],
    success: [],
    failed: [],
    waiting_for_approval: ['pending', 'failed'],
    paused: ['running', 'cancelled'],
    cancelled: [],
};
/**
 * 判断状态转换是否有效
 */
export function isValidTransition(from, to) {
    return VALID_STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}
/**
 * 将旧版状态映射到新版
 */
export function mapLegacyStatus(status) {
    switch (status) {
        case 'ok': return 'success';
        case 'error': return 'failed';
        case 'skipped': return 'cancelled';
    }
}
/**
 * 将新版状态映射到旧版（向后兼容）
 */
export function mapToLegacyStatus(status) {
    switch (status) {
        case 'success': return 'ok';
        case 'failed': return 'error';
        case 'cancelled': return 'skipped';
        default: return null;
    }
}
/**
 * 日志级别权重（用于过滤）
 */
export const LOG_LEVEL_WEIGHT = {
    debug: 0,
    info: 1,
    stream: 2,
    warn: 3,
    error: 4,
};
/**
 * 默认错误退避时间表
 */
export const DEFAULT_ERROR_BACKOFF_MS = [
    30_000, // 1st error → 30 seconds
    60_000, // 2nd error → 1 minute
    300_000, // 3rd error → 5 minutes
    900_000, // 4th error → 15 minutes
    3_600_000, // 5th+ error → 60 minutes
];
/**
 * 获取错误退避时间
 */
export function getErrorBackoffMs(consecutiveErrors) {
    const idx = Math.min(consecutiveErrors, DEFAULT_ERROR_BACKOFF_MS.length - 1);
    return DEFAULT_ERROR_BACKOFF_MS[Math.max(0, idx)];
}
