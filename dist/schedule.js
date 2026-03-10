/**
 * MCP Cron Server - 调度时间计算模块
 *
 * 提供：
 * - computeNextRunAtMs() - 计算下次执行时间
 * - isJobDue() - 判断任务是否到期
 * - formatNextRun() - 格式化显示时间
 *
 * ## anchorMs（锚点）说明
 *
 * interval 任务的执行时间并非绝对精确，而是相对于"锚点"计算：
 * - 如果未指定 anchorMs，则默认以首次创建任务的时间作为锚点
 * - 下次执行时间 = anchor + floor((now - anchor) / interval) * interval + interval
 *
 * 这意味着：
 * - 任务会在每个 interval 周期的起点触发（而非任意时刻）
 * - 例如：每 5 分钟执行，anchor 为 10:00:00，则执行时间为 10:05:00、10:10:00...
 * - 如果任务在 10:01:00 触发检查，会计算到下一个周期 10:05:00
 *
 * 这样设计的好处是多个间隔任务可以同步调度，避免频繁唤醒进程。
 *
 * @module schedule
 */
import { Cron } from 'croner';
/**
 * 计算下次执行时间（毫秒时间戳）
 *
 * @param schedule 调度配置
 * @param nowMs 当前时间（毫秒），默认 Date.now()
 * @returns 下次执行时间戳，如果无法计算则返回 undefined
 */
export function computeNextRunAtMs(schedule, nowMs = Date.now()) {
    switch (schedule.kind) {
        case 'at':
            // 一次性任务：如果已过执行时间，返回 undefined（不会再执行）
            if (schedule.atMs <= nowMs) {
                return undefined;
            }
            return schedule.atMs;
        case 'every':
            // 间隔任务
            // 如果没有 anchor（锚点），则从当前时间开始
            const anchor = schedule.anchorMs ?? nowMs;
            const elapsed = nowMs - anchor;
            const intervals = Math.floor(elapsed / schedule.everyMs);
            const nextAnchor = anchor + (intervals + 1) * schedule.everyMs;
            return nextAnchor;
        case 'cron':
            // Cron 表达式
            // croner 支持在表达式中指定时区，格式: "expr timezone"
            // 例如: "0 8 * * * Asia/Shanghai"
            try {
                const cronExpr = schedule.tz
                    ? `${schedule.expr} ${schedule.tz}`
                    : schedule.expr;
                const cron = new Cron(cronExpr);
                const nextRun = cron.nextRun(new Date(nowMs));
                return nextRun ? nextRun.getTime() : undefined;
            }
            catch (error) {
                console.error('[schedule] Invalid cron expression:', schedule.expr, error);
                return undefined;
            }
        default:
            return undefined;
    }
}
/**
 * 判断任务是否到期执行
 *
 * @param nextRunAtMs 下次执行时间
 * @param nowMs 当前时间，默认 Date.now()
 * @returns 是否到期
 */
export function isJobDue(nextRunAtMs, nowMs = Date.now()) {
    if (nextRunAtMs === null || nextRunAtMs === undefined) {
        return false;
    }
    return nextRunAtMs <= nowMs;
}
/**
 * 格式化下次执行时间
 *
 * @param nextRunAtMs 下次执行时间戳（毫秒）
 * @returns 格式化的时间字符串，如果是 null 则返回 "N/A"
 */
export function formatNextRun(nextRunAtMs) {
    if (nextRunAtMs === null || nextRunAtMs === undefined) {
        return 'N/A';
    }
    const date = new Date(nextRunAtMs);
    const now = new Date();
    const diffMs = nextRunAtMs - now.getTime();
    // 如果是过去的时间
    if (diffMs < 0) {
        return 'overdue';
    }
    // 小于 1 分钟
    if (diffMs < 60_000) {
        const seconds = Math.floor(diffMs / 1000);
        return `in ${seconds}s`;
    }
    // 小于 1 小时
    if (diffMs < 3600_000) {
        const minutes = Math.floor(diffMs / 60_000);
        return `in ${minutes}m`;
    }
    // 小于 24 小时
    if (diffMs < 86400_000) {
        const hours = Math.floor(diffMs / 3600_000);
        return `in ${hours}h`;
    }
    // 大于等于 1 天
    const days = Math.floor(diffMs / 86400_000);
    if (days === 1) {
        return 'tomorrow';
    }
    // 超过 1 天，显示具体日期
    return date.toLocaleString();
}
