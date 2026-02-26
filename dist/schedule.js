import { Cron } from 'croner';
export function computeNextRunAtMs(schedule, nowMs) {
    if (schedule.kind === 'at') {
        const atMs = schedule.atMs;
        return atMs > nowMs ? atMs : undefined;
    }
    if (schedule.kind === 'every') {
        const everyMs = Math.max(1, Math.floor(schedule.everyMs));
        const anchor = Math.max(0, Math.floor(schedule.anchorMs ?? nowMs));
        if (nowMs < anchor) {
            return anchor;
        }
        const elapsed = nowMs - anchor;
        const steps = Math.max(1, Math.floor((elapsed + everyMs - 1) / everyMs));
        return anchor + steps * everyMs;
    }
    const expr = schedule.expr.trim();
    if (!expr) {
        return undefined;
    }
    const cron = new Cron(expr, {
        timezone: schedule.tz || 'Asia/Shanghai',
        catch: false,
    });
    const next = cron.nextRun(new Date(nowMs));
    if (!next) {
        return undefined;
    }
    const nextMs = next.getTime();
    if (!Number.isFinite(nextMs)) {
        return undefined;
    }
    if (nextMs > nowMs) {
        return nextMs;
    }
    const nextSecondMs = Math.floor(nowMs / 1000) * 1000 + 1000;
    const retry = cron.nextRun(new Date(nextSecondMs));
    if (!retry) {
        return undefined;
    }
    const retryMs = retry.getTime();
    return Number.isFinite(retryMs) && retryMs > nowMs ? retryMs : undefined;
}
export function isJobDue(job, nowMs) {
    if (!job.state.nextRunAtMs) {
        return false;
    }
    return job.state.nextRunAtMs <= nowMs;
}
export function formatNextRun(nextRunAtMs) {
    if (!nextRunAtMs)
        return 'N/A';
    const date = new Date(nextRunAtMs);
    const now = new Date();
    const diff = nextRunAtMs - now.getTime();
    if (diff < 0) {
        return 'Overdue';
    }
    if (diff < 60000) {
        return `${Math.floor(diff / 1000)}s`;
    }
    if (diff < 3600000) {
        return `${Math.floor(diff / 60000)}m`;
    }
    if (diff < 86400000) {
        return `${Math.floor(diff / 3600000)}h`;
    }
    return date.toLocaleString('zh-CN', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}
