/**
 * MCP Cron Server - MCP 接口入口
 *
 * 提供以下 MCP Tools：
 * - cron_add: 添加定时任务（含 Cron 表达式预验证）
 * - cron_list: 列出所有任务
 * - cron_get: 获取单个任务详情
 * - cron_update: 更新任务
 * - cron_remove: 删除任务
 * - cron_run: 立即执行任务
 * - cron_status: 获取调度器状态
 * - cron_get_approvals: 获取待审批列表
 * - cron_approve: 批准执行
 * - cron_reject: 拒绝执行
 * - cron_get_logs: 获取执行日志
 * - cron_get_stats: 获取系统统计
 * - cron_get_history: 获取执行历史
 * - cron_list_executions: 分页列出所有执行记录
 *
 * @module index
 */
export {};
