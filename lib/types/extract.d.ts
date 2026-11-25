import type { AgentLike, CtxLike, MessageLike } from './types.js';
export interface CheckpointFacts {
    goal: string;
    done: string[];
    pending_todos: string[];
    key_decisions: string[];
    last_human_request: string;
    /** 项目的**原始需求原文**（链上继承；空 = 没采集到）。 */
    original_request: string;
    /** 原始需求来自哪个会话（便于追溯）。 */
    original_request_source: string;
    notes: string[];
    /**
     * 原始待办列表（含状态，供"交接后把旧窗口的待办标成已完成"用）。
     * 不进检查点文档、不进简报；只在本进程内使用。
     */
    allTodos: TodoItem[];
}
/** 取消息里的文本块；推理块/工具块一律忽略。 */
export declare function messageText(message: MessageLike | undefined): string;
export interface TodoItem {
    text: string;
    status: string;
}
export declare function cwdOf(agent: AgentLike | undefined): string | undefined;
/** 采集交接事实。任何一步失败都降级为「该字段为空」，不抛（写入检查点时才有硬失败）。 */
export declare function collectFacts(ctx: CtxLike, agent: AgentLike): CheckpointFacts;
