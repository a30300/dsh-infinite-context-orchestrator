import type { CheckpointFacts } from './extract.js';
import type { AgentLike, CtxLike } from './types.js';
export interface ModelBriefRequest {
    facts: CheckpointFacts;
    checkpointPath: string;
    occupancyLine?: string;
    /** 简报字符上限（0 = 不限制）；用来推导 maxTokens 与素材长度。 */
    maxChars: number;
    signal?: AbortSignal;
}
export interface ModelBriefResult {
    ok: boolean;
    text?: string;
    reason?: string;
}
/**
 * 请求模型写一份简报。任何失败都返回 `{ ok: false, reason }`，
 * 调用方必须回退到模板渲染（fail-open 到确定性内容，而不是阻断换窗）。
 */
export declare function requestModelBrief(ctx: CtxLike, agent: AgentLike, request: ModelBriefRequest): Promise<ModelBriefResult>;
