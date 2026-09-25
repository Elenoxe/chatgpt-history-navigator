import { getConversationContextSnapshot } from "./page"

// MAIN-world adapters for ChatGPT history loading and navigation.
// Internal callbacks are discovered without fixed bundle names or memo slots.
type Fiber = {
  return?: Fiber
  memoizedState?: { memoizedState?: unknown; next?: Fiber["memoizedState"] }
  memoizedProps?: Record<string, unknown>
  updateQueue?: { memoCache?: { data?: unknown[][] } }
}

let nativeNavigation: { messageId: string; pending: () => boolean; cancel: () => void } | undefined

export function controlNativeNavigation(messageId: string, cancel: boolean): boolean {
  if (nativeNavigation?.messageId !== messageId) return false
  if (cancel) {
    nativeNavigation.cancel()
    nativeNavigation = undefined
    return false
  }
  return nativeNavigation.pending()
}

type NativeHistoryLoader = (
  conversationId: string,
  options: {
    includeMessageId: string
    forceNetworkFetch: boolean
    signal: AbortSignal
    shouldApplyResponse: () => boolean
    onConversationAppliedFromNetwork: () => void
  },
) => Promise<unknown>

export async function loadQuestionHistory(
  messageId: string,
  signal: AbortSignal,
): Promise<boolean> {
  const pathname = location.pathname
  const conversationId = pathname.match(/\/c\/([^/]+)\/?$/)?.[1]
  // Preload links can disappear after SPA navigation. The route manifest keeps
  // the current module URL even after its link and resource timing entry are gone.
  const imports = (
    window as Window & {
      __reactRouterManifest?: { routes?: Record<string, { imports?: unknown }> }
    }
  ).__reactRouterManifest?.routes?.["routes/_conversation"]?.imports
  if (!conversationId || !Array.isArray(imports)) return false
  const modulePath = imports.find(
    (path): path is string =>
      typeof path === "string" && /^\/cdn\/assets\/conversation-small-[\w-]+\.js$/.test(path),
  )
  if (!modulePath) return false
  // Only import a same-origin asset; identify its loader by the option contract,
  // never by a bundled hash or minified export name.
  const exports: Record<string, unknown> = await import(
    /* @vite-ignore */ new URL(modulePath, location.origin).href
  )
  signal.throwIfAborted()
  const loaders = Object.values(exports).filter((value): value is NativeHistoryLoader => {
    if (typeof value !== "function") return false
    const source = Function.prototype.toString.call(value)
    return (
      source.startsWith("async function") &&
      [
        "includeMessageId",
        "forceNetworkFetch",
        "shouldApplyResponse",
        "onConversationAppliedFromNetwork",
      ].every((field) => new RegExp(`\\b${field}\\s*:`).test(source))
    )
  })
  if (loaders.length !== 1) return false
  const isCurrent = () => !signal.aborted && location.pathname === pathname
  if (!isCurrent()) return false
  // The host owns parsing, branch state and pagination cursors. Never inject our
  // Query cache into its store. Late responses must not replace a newer target.
  let applied = false
  await loaders[0]!(conversationId, {
    includeMessageId: messageId,
    forceNetworkFetch: true,
    signal,
    shouldApplyResponse: isCurrent,
    onConversationAppliedFromNetwork: () => {
      applied = true
    },
  })
  signal.throwIfAborted()
  if (!isCurrent()) return false
  if (!applied) throw new Error("Native history response was not applied")
  return true
}

export function revealQuestion(messageId: string): boolean {
  const element =
    document.querySelector<HTMLElement>(
      `main [data-turn-id-container="${CSS.escape(messageId)}"]`,
    ) ?? document.querySelector<HTMLElement>("main [data-turn-id-container]")
  // The callback belongs to the conversation, not the target turn. An existing
  // turn can expose it before the requested turn has a placeholder.
  if (!element) return false
  const key = Object.keys(element).find((key) => key.startsWith("__reactFiber$"))
  if (!key) return false
  let fiber = (element as unknown as Record<string, Fiber>)[key]
  const callbacks = new Set<(turnId: string, messageId: string) => void>()
  const finishCallbacks = new Set<(requestId: number) => void>()
  const refs: { current: unknown }[] = []
  let flushSync: ((callback: () => void) => void) | undefined
  for (; fiber; fiber = fiber.return) {
    const props = fiber.memoizedProps
    if (typeof props?.flushSync === "function") {
      flushSync = props.flushSync as typeof flushSync
    }
    if (
      !props?.conversation ||
      !("scrollContainerRef" in props) ||
      !("enableTableOfContents" in props)
    )
      continue
    for (let hook = fiber.memoizedState; hook; hook = hook.next) {
      const value = hook.memoizedState
      if (value && typeof value === "object" && "current" in value) refs.push(value)
    }
    for (const value of fiber.updateQueue?.memoCache?.data?.flat() ?? []) {
      if (typeof value !== "function") continue
      const source = Function.prototype.toString.call(value)
      if (
        value.length === 1 &&
        source.includes(".requestId===") &&
        source.includes(".current=null") &&
        !source.includes("turnId")
      ) {
        finishCallbacks.add(value as (requestId: number) => void)
      }
      if (
        value.length === 2 &&
        ["messageId", "turnId", "requestId"].every((field) =>
          new RegExp(`\\b${field}\\s*:`).test(source),
        )
      ) {
        callbacks.add(value as (turnId: string, messageId: string) => void)
      }
    }
  }
  if (callbacks.size !== 1 || finishCallbacks.size !== 1 || !flushSync) return false
  const callback = [...callbacks][0]!
  // Commit the reveal immediately, including when background React work is
  // throttled. No private state is overwritten and the host owns rendering.
  flushSync(() => callback(messageId, messageId))
  const ref = refs.find((ref) => {
    const value = ref.current
    return (
      value &&
      typeof value === "object" &&
      "messageId" in value &&
      value.messageId === messageId &&
      "requestId" in value &&
      typeof value.requestId === "number"
    )
  })
  if (!ref) return false
  const request = ref.current as { requestId: number }
  const finish = [...finishCallbacks][0]!
  const commit = flushSync
  nativeNavigation = {
    messageId,
    pending: () => ref.current === request,
    cancel: () => {
      if (ref.current === request) commit(() => finish(request.requestId))
    },
  }
  return true
}

type Loader = (signal: AbortSignal) => Promise<void>

function findLoader(conversationId: string): Loader | null | undefined {
  const seen = new Set<Fiber>()
  const loaders = new Set<Loader>()
  let ready = false
  // The conversation component exists before its first message DOM node.
  for (const element of document.querySelectorAll("*")) {
    const key = Object.keys(element).find((name) => name.startsWith("__reactFiber$"))
    let fiber = key ? (element as unknown as Record<string, Fiber>)[key] : undefined
    for (; fiber && !seen.has(fiber); fiber = fiber.return) {
      seen.add(fiber)
      const props = fiber.memoizedProps
      if (
        props?.conversationId !== conversationId ||
        props.composerConversationId !== conversationId ||
        !Array.isArray(props.entries)
      )
        continue
      ready = true
      for (const value of fiber.updateQueue?.memoCache?.data?.flat() ?? []) {
        if (typeof value !== "function") continue
        // Match the one-signal callback's store lookup and awaited loader call.
        // No bundle name, minified identifier or memo slot is fixed. A changed
        // contract is unavailable, never a reason to invoke an arbitrary callback.
        const source = Function.prototype.toString.call(value)
        if (
          /^async\s+([\w$]+)=>\{let\s+([\w$]+)=([\w$]+)\.get\([^;]+\);[^;{}]*\.get\([^;]+\)>0&&await\s+\(0,[\w$]+\.[\w$]+\)\(\3,\2,\1\)\}$/.test(
            source,
          )
        )
          loaders.add(value as Loader)
      }
    }
  }
  return loaders.size === 1 ? [...loaders][0]! : ready ? null : undefined
}

export async function ensureNativeHistory(
  userId: string,
  conversationId: string,
  signal: AbortSignal,
): Promise<boolean> {
  const snapshot = JSON.stringify([userId, conversationId])
  const check = () => {
    signal.throwIfAborted()
    if (getConversationContextSnapshot() !== snapshot)
      throw new DOMException("Conversation changed", "AbortError")
  }
  const loader = await new Promise<Loader | null>((resolve, reject) => {
    const startedAt = performance.now()
    console.debug("[chatgpt-history-navigator] Waiting for native history loader:", {
      conversationId,
    })
    let timer: ReturnType<typeof setTimeout>
    const observer = new MutationObserver(scan)
    // Bound discovery only, never the host's network request. If the host no
    // longer exposes this component, the explicitly supported API path remains usable.
    const deadline = setTimeout(() => {
      cleanup()
      console.warn("[chatgpt-history-navigator] Native history component unavailable after 15s")
      resolve(null)
    }, 15_000)
    function cleanup() {
      clearTimeout(timer)
      clearTimeout(deadline)
      observer.disconnect()
      signal.removeEventListener("abort", abort)
    }
    function abort() {
      console.debug("[chatgpt-history-navigator] Native history discovery cancelled:", {
        conversationId,
      })
      cleanup()
      reject(signal.reason)
    }
    function scan() {
      clearTimeout(timer)
      try {
        check()
        const found = findLoader(conversationId)
        if (found !== undefined) {
          if (found)
            console.debug("[chatgpt-history-navigator] Native history loader ready:", {
              conversationId,
              elapsedMs: Math.round(performance.now() - startedAt),
            })
          else
            console.warn(
              "[chatgpt-history-navigator] Native history loader missing or ambiguous:",
              { conversationId },
            )
          cleanup()
          resolve(found)
        } else timer = setTimeout(scan, 250)
      } catch (error) {
        cleanup()
        reject(error)
      }
    }
    signal.addEventListener("abort", abort, { once: true })
    observer.observe(document.documentElement, { childList: true, subtree: true })
    scan()
  })
  check()
  if (!loader) return false
  console.debug("[chatgpt-history-navigator] Calling native history loader:", { conversationId })
  await loader(signal)
  check()
  return true
}
