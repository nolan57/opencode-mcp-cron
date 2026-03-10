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
import type { CronSchedule } from './types.js';
/**
 * 计算下次执行时间（毫秒时间戳）
 *
 * @param schedule 调度配置
 * @param nowMs 当前时间（毫秒），默认 Date.now()
 * @returns 下次执行时间戳，如果无法计算则返回 undefined
 */
export declare function computeNextRunAtMs(schedule: CronSchedule, nowMs?: number): number | undefined;
/**
 * 判断任务是否到期执行
 *
 * @param nextRunAtMs 下次执行时间
 * @param nowMs 当前时间，默认 Date.now()
 * @returns 是否到期
 */
export declare function isJobDue(nextRunAtMs: number | null | undefined, nowMs?: number): boolean;
/**
 * 格式化下次执行时间
 *
 * @param nextRunAtMs 下次执行时间戳（毫秒）
 * @returns 格式化的时间字符串，如果是 null 则返回 "N/A"
 */
export declare function formatNextRun(nextRunAtMs: number | null | undefined): string;
