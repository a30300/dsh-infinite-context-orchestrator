/**
 * 超时与安全调用小工具。
 *
 * 为什么单独成文件：宿主 `llm.listProviders()/listModels()` 在实测里**返回的不是 Promise**
 * （同步值），直接 `.then` 会抛 `task.then is not a function` → 设置路由 500。
 * 这里统一用 `Promise.resolve` 包一层，并暴露给测试（`__testing.withTimeout`）。
 */

/** 给可能触网/可能同步返回的调用加超时；失败或超时都返回 undefined。 */
export async function withTimeout<T>(task: Promise<T> | T | undefined, timeoutMs: number): Promise<T | undefined> {
  const promise = Promise.resolve(task as T | undefined)
  return await new Promise<T | undefined>((resolve) => {
    const timer = setTimeout(() => resolve(undefined), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(undefined)
      },
    )
  })
}

/** 同步执行一次可能抛错/未实现的调用（发现接口不是每个宿主都有）。 */
export function safeCall<T>(thunk: () => T | undefined): T | undefined {
  try {
    return thunk()
  } catch {
    return undefined
  }
}