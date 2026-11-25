/**
 * 插件配置：schemastery schema（Cordis 原生 Config 约定）+ 运行期归一化。
 *
 * 注意两点（都是踩过的坑）：
 * 1. profile 的 cordis.patch.yml 对同一 entry 是「整体替换 config」语义，所以
 *    任何字段缺省都必须有 default —— 你只写 `enabled: true` 时，其余字段由
 *    schemastery 的 default 兜底，不会被读成 undefined。
 * 2. 加载期 fail-loud：非法值直接抛 TypeError 并指明字段，不要静默改成默认值，
 *    否则「阈值写错 → 永远不触发」这种问题只能靠猜。
 */
import z from '@deepseek-ai/schemastery';
export interface OrchestratorConfig {
    enabled: boolean;
    /** 单次插件加载内允许的自动换窗次数上限（0 = 不限制）。本地小窗口模型需要反复换窗。 */
    maxAutoHandoffs: number;
    /** 逐模型窗口覆盖：键是 ${provider}/ 或 ${model}，值是真实窗口（0 = 忽略）。 */
    contextWindowByModel: Record<string, number>;
    /** 按模型的百分比阈值（键同上）；未列出的模型用 thresholdPercent。 */
    thresholdByModel: Record<string, number>;
    autoHandoff: boolean;
    checkpointMaxBytes: number;
    handoffBriefMaxChars: number;
    checkpointRoot: string;
    projectProgressReserveChars: number;
    /** 换窗后是否在旧窗口主动开一次极短回复，立刻显示「任务已转移」。 */
    notifyTransferredSession: boolean;
    /** 交接成功后是否把旧会话的待办标成已完成（避免旧窗口挂着假任务）。 */
    markTodosHandedOff: boolean;
    /** 简报由谁写：插件模板（确定性）或模型（多一次调用）。 */
    briefAuthor: 'plugin' | 'model';
    /** 交接时是否把「原始需求」一路带着（默认 true）。 */
    carryOriginalRequest: boolean;
}
export declare const CONFIG_DEFAULTS: Readonly<OrchestratorConfig>;
/**
 * 三个数值上限支持「不限制」哨兵值（设置页的「不限制」勾选框写的就是它）：
 *   - checkpointMaxBytes: 0          → 不裁剪检查点体积
 *   - handoffBriefMaxChars: 0        → 不裁剪交接简报正文
 *   - projectProgressReserveChars: -1 → 项目摘要不设上限（也不占简报预算）
 * 之所以不用 null/undefined：schema 里 null 表示「没写」，无法与「显式不限制」区分。
 */
export declare const UNLIMITED: Readonly<{
    checkpointMaxBytes: 0;
    handoffBriefMaxChars: 0;
    projectProgressReserveChars: -1;
}>;
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    enabled: z<boolean, boolean, "defined">;
    maxAutoHandoffs: z<number, number, "defined">;
    thresholdByModel: z<any, any, "defined">;
    contextWindowByModel: z<any, any, "defined">;
    autoHandoff: z<boolean, boolean, "defined">;
    notifyTransferredSession: z<boolean, boolean, "defined">;
    markTodosHandedOff: z<boolean, boolean, "defined">;
    checkpointMaxBytes: z<number, number, "defined">;
    handoffBriefMaxChars: z<number, number, "defined">;
    checkpointRoot: z<string, string, "defined">;
    projectProgressReserveChars: z<number, number, "defined">;
    carryOriginalRequest: z<boolean, boolean, "defined">;
    briefAuthor: z<string, string, "defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    enabled: z<boolean, boolean, "defined">;
    maxAutoHandoffs: z<number, number, "defined">;
    thresholdByModel: z<any, any, "defined">;
    contextWindowByModel: z<any, any, "defined">;
    autoHandoff: z<boolean, boolean, "defined">;
    notifyTransferredSession: z<boolean, boolean, "defined">;
    markTodosHandedOff: z<boolean, boolean, "defined">;
    checkpointMaxBytes: z<number, number, "defined">;
    handoffBriefMaxChars: z<number, number, "defined">;
    checkpointRoot: z<string, string, "defined">;
    projectProgressReserveChars: z<number, number, "defined">;
    carryOriginalRequest: z<boolean, boolean, "defined">;
    briefAuthor: z<string, string, "defined">;
}>>, "plain">;
/** 把加载器传进来的原始配置解析成完整、可用的配置对象；非法值 fail-loud。 */
export declare function resolveConfig(raw: unknown): OrchestratorConfig;
