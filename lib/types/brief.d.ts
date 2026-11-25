import type { CheckpointFacts } from './extract.js';
/**
 * 读 dsh-project-progress 的 PROGRESS.md，取「项目档案 + 时间线尾部」。
 * 该文件由 dsh-project-progress 维护；这里只读，不写（避免两个插件争同一份文件）。
 */
export declare function readProjectProgressSummary(cwd: string | undefined, maxChars: number): string;
export interface BriefResult {
    text: string;
    chars: number;
    hasProjectSummary: boolean;
    truncated: boolean;
}
export interface BriefOptions {
    maxChars: number;
    projectProgressReserveChars: number;
    cwd?: string;
    /** 可选的占用说明行（放在标题下方，便于新会话知道为什么换窗）。 */
    occupancyLine?: string;
}
export declare function renderModelAuthoredBrief(modelText: string, facts: CheckpointFacts, checkpointPath: string, options: BriefOptions): BriefResult;
/**
 * 渲染交接简报（格式与需求一致，逐档降级到预算内）。
 *
 * 两种「不限制」（设置页的勾选框写入的哨兵值）：
 *   - `maxChars <= 0`         → 简报**不裁剪**：按最详细档渲染，不做长度检查。
 *   - `reserveChars < 0`      → 项目摘要**不裁剪**，且**不占用**简报的字数预算
 *                               （此时只量简报正文，项目摘要额外挂上）。
 */
export declare function renderHandoffBrief(facts: CheckpointFacts, checkpointPath: string, options: BriefOptions): BriefResult;
