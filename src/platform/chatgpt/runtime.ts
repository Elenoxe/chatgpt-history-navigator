import { getConversationContextSnapshot } from "./page"

// MAIN-world adapters for ChatGPT history loading and navigation.
// Internal callbacks are discovered without fixed bundle names or memo slots.
type Fiber = {
  return?: Fiber
  memoizedState?: { memoizedState?: unknown; next?: Fiber["memoizedState"] }
  memoizedProps?: Record<string, unknown>
  updateQueue?: { memoCache?: { data?: unknown[][] } }
}

type NativeNavigation = {
  getEntryGeometry: (key: string) => { startPx: number; endPx: number } | null
  scrollToKey: (
    key: string,
    getTargetElement: undefined,
    options: { align: "top"; signal: AbortSignal },
  ) => Promise<void>
}

function findNavigation(): NativeNavigation | undefined {
  const seen = new Set<Fiber>()
  for (const element of document.querySelectorAll("main *")) {
    const key = Object.keys(element).find((name) => name.startsWith("__reactFiber$"))
    let fiber = key ? (element as unknown as Record<string, Fiber>)[key] : undefined
    for (; fiber && !seen.has(fiber); fiber = fiber.return) {
      seen.add(fiber)
      for (let hook = fiber.memoizedState; hook; hook = hook.next) {
        const value = hook.memoizedState
        if (
          value &&
          typeof value === "object" &&
          "getEntryGeometry" in value &&
          typeof value.getEntryGeometry === "function" &&
          "scrollToKey" in value &&
          typeof value.scrollToKey === "function"
        )
          return value as NativeNavigation
      }
    }
  }
}

export async function revealQuestion(messageId: string, signal: AbortSignal): Promise<boolean> {
  signal.throwIfAborted()
  const snapshot = getConversationContextSnapshot()
  let navigation = findNavigation()
  if (!navigation) return false
  if (!navigation.getEntryGeometry(messageId)) {
    const [userId, conversationId] = JSON.parse(snapshot) as [string | null, string | null]
    if (!userId || !conversationId) return false
    console.debug("[chatgpt-history-navigator] Loading history for navigation:", { messageId })
    if (!(await ensureNativeHistory(userId, conversationId, signal))) return false
    // Let the host commit the loaded entries before reading its virtual-list API.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    signal.throwIfAborted()
    if (getConversationContextSnapshot() !== snapshot)
      throw new DOMException("Conversation changed", "AbortError")
    navigation = findNavigation()
    if (!navigation?.getEntryGeometry(messageId)) return false
  }
  await navigation.scrollToKey(messageId, undefined, { align: "top", signal })
  signal.throwIfAborted()
  if (getConversationContextSnapshot() !== snapshot)
    throw new DOMException("Conversation changed", "AbortError")
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
