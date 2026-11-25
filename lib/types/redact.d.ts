/**
 * 凭据脱敏。
 *
 * 检查点会被新会话（可能还有另一个模型）读到，所以写入前必须假定字符串里
 * 可能夹着 token / cookie / 私钥。这里只做「保守但明显」的替换：
 * 宁可多遮一点，也不要把凭据带进新窗口。
 *
 * 原则：不改变正常的自然语言与代码标识符；只动「长得像凭据」的片段。
 */
export interface RedactOptions {
    /** 当前用户主目录；缺省用 $USERPROFILE / $HOME。 */
    home?: string;
    /** 单字段扫描上限，防止对超大文本做正则回溯。 */
    maxChars?: number;
}
/** 脱敏任意文本；幂等（重复调用不会破坏 [REDACTED] 标记）。 */
export declare function redactText(input: string, options?: RedactOptions): string;
/** 递归脱敏任意 JSON 兼容值（对象键名不动，只洗字符串值）。 */
export declare function redactValue(value: unknown, options?: RedactOptions, depth?: number): unknown;
