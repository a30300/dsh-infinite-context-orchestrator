import { mkdir } from 'node:fs/promises';
/** 检查点文档（字段名与需求一致：goal/done/pending_todos/key_decisions/last_human_request/checkpoint_path）。 */
export interface HandoffCheckpoint {
    version: number;
    plugin: string;
    createdAt: string;
    sessionId: string;
    parentSession?: string;
    agentPreset?: string;
    cwd?: string;
    goal: string;
    done: string[];
    pending_todos: string[];
    key_decisions: string[];
    last_human_request: string;
    checkpoint_path: string;
    occupancy?: {
        usedTokens?: number;
        windowTokens?: number;
        percent?: number;
        thresholdPercent: number;
        source: string;
    };
    nextSessionId?: string;
    notes?: string[];
}
export interface LatestPointer {
    checkpointPath: string;
    sessionId: string;
    nextSessionId?: string;
    createdAt: string;
    briefChars?: number;
}
/** `${DSH_HOME:-~/.dsh}/task-checkpoints/orchestrator`（或配置里的绝对路径）。 */
export declare function resolveCheckpointRoot(configured: string | undefined): string;
/** 原子替换一个文本文件，并把上一版保留为 `<target>.previous`。 */
export declare function atomicWriteText(target: string, text: string): Promise<void>;
export declare class CheckpointWriteError extends Error {
    readonly cause?: unknown | undefined;
    constructor(message: string, cause?: unknown | undefined);
}
export interface WriteCheckpointResult {
    checkpointPath: string;
    bytes: number;
    trimmed: boolean;
}
/**
 * 写一份交接检查点（三层落盘）：
 *   1. `handoffs/<sessionId>.json` —— **每会话稳定路径**，原子替换并保留 `.previous`
 *      （同一会话再次交接时旧版就留在 `.previous`，可回滚）；`checkpoint_path` 指向它。
 *   2. `handoffs/history/<时间戳>-<sessionId>.json` —— 不可变历史副本（保留最近 50 份），
 *      防止「稳定路径被覆盖后想找回更早的版本」。
 *   3. `latest.json` —— 指针，状态工具与人工排查都读它。
 *
 * 任何失败都抛 CheckpointWriteError —— 上层必须据此**拒绝换窗**（fail-closed）。
 * 第 2/3 层是附加保障，写失败只记日志、不阻断交接；第 1 层才是硬门。
 */
export declare function writeCheckpoint(root: string, doc: HandoffCheckpoint, maxBytes: number): Promise<WriteCheckpointResult>;
/** 把原始需求落盘成 `requirements/<工作区>.md`（内容不变就不重写）。 */
export declare function writeRequirementFile(root: string, cwd: string, text: string, source: string): string | undefined;
/**
 * 在最近的检查点里找「原始需求」。
 * 用于链式继承：新窗口自己没有任何用户消息时，沿用上一份检查点里的原文。
 */
export declare function findOriginalRequest(root: string, cwd: string): {
    text: string;
    source: string;
} | undefined;
export declare function sessionCheckpointPath(root: string, sessionId: string): string;
/** 该会话是否已经交接过（存在检查点即视为已交接；重启后依然有效）。 */
export declare function hasSessionCheckpoint(root: string, sessionId: string): boolean;
export declare function readLatestPointer(root: string): LatestPointer | undefined;
/** 读一份检查点正文（给「新会话被要求回读」时用，也便于排查）。 */
export declare function readCheckpointText(file: string): string | undefined;
export interface PendingBrief {
    sessionId: string;
    createdAt: number;
    text: string;
    checkpointPath: string;
    sourceSessionId?: string;
}
export declare const PENDING_TTL_MS: number;
export declare function pendingBriefPath(root: string, sessionId: string): string;
export declare function savePendingBrief(root: string, brief: PendingBrief): Promise<string>;
export declare function loadPendingBrief(root: string, sessionId: string): PendingBrief | undefined;
export declare function clearPendingBrief(root: string, sessionId: string): void;
export { mkdir as ensureDirectory };
