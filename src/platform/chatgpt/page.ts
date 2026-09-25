import { z } from "zod"
import type { ContentScriptContext } from "wxt/utils/content-script-context"
import { tryRevealQuestion } from "./bridge"

const pageChangeEvent = "chatgpt-history-navigator:pagechange"

export function observeComposerOffset(onChange: (bottom: number) => void): () => void {
  let composer: HTMLFormElement | null = null
  const resize = new ResizeObserver(update)
  function update() {
    const next = document.querySelector("#prompt-textarea")?.closest("form") ?? null
    if (next !== composer) {
      resize.disconnect()
      composer = next
      if (composer) resize.observe(composer)
    }
    const bounds = composer?.getBoundingClientRect()
    onChange(bounds?.height ? Math.max(24, window.innerHeight - bounds.top + 16) : 24)
  }
  const mutations = new MutationObserver(update)
  mutations.observe(document.body, { childList: true, subtree: true })
  window.addEventListener("resize", update)
  update()
  return () => {
    resize.disconnect()
    mutations.disconnect()
    window.removeEventListener("resize", update)
  }
}

export function hideNativeTimeline(): () => void {
  const style = document.createElement("style")
  // Hide the native TOC's fixed wrapper, keeping its React navigation state intact.
  // A page-level rule also covers TOCs mounted after history finishes loading.
  style.textContent = "div.fixed:has(button[data-toc-item-index]) { display: none !important; }"
  document.head.append(style)
  return () => style.remove()
}

// DOM is used only for navigation and reading position; content stays in the API cache.
export async function scrollToQuestion(
  messageId: string,
  questionIds: readonly string[],
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted()
  const snapshot = getConversationContextSnapshot()
  const startedAt = performance.now()
  console.debug("[chatgpt-history-navigator] Navigation started:", { messageId })
  await new Promise<void>((resolve, reject) => {
    const controller = new AbortController()
    let frame = 0
    let stopped = false
    let direction = -1
    const mutations = new MutationObserver(schedule)
    const resize = new ResizeObserver(schedule)
    const root = document.querySelector<HTMLElement>("main [data-app-action-timeline-scroll]")
    if (!root) {
      reject(new Error("Conversation scroll container unavailable"))
      return
    }
    const cleanup = () => {
      stopped = true
      controller.abort()
      cancelAnimationFrame(frame)
      mutations.disconnect()
      resize.disconnect()
      signal.removeEventListener("abort", abort)
      window.removeEventListener(pageChangeEvent, conversationChanged)
      document.removeEventListener("wheel", manual, true)
      document.removeEventListener("touchstart", manual, true)
      document.removeEventListener("pointerdown", manual, true)
      document.removeEventListener("keydown", keyboard, true)
    }
    const abort = () => {
      cleanup()
      reject(signal.reason)
    }
    const cancel = () => {
      console.debug("[chatgpt-history-navigator] Navigation cancelled:", { messageId })
      cleanup()
      resolve()
    }
    const conversationChanged = () => {
      if (getConversationContextSnapshot() !== snapshot) cancel()
    }
    const manual = (event: Event) => {
      if (event.composedPath().includes(root)) cancel()
    }
    const keyboard = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" ||
        (event.composedPath().includes(root) &&
          ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key))
      )
        cancel()
    }
    const finish = (source: string) => {
      console.debug("[chatgpt-history-navigator] Navigation completed:", {
        messageId,
        source,
        elapsedMs: Math.round(performance.now() - startedAt),
      })
      cleanup()
      resolve()
    }
    function schedule() {
      if (!stopped && !frame) frame = requestAnimationFrame(advance)
    }
    function advance() {
      frame = 0
      if (stopped) return
      if (getConversationContextSnapshot() !== snapshot) return cancel()
      if (!root!.isConnected) {
        cleanup()
        reject(new Error("Conversation scroll container removed"))
        return
      }
      const target = root!.querySelector<HTMLElement>(`[data-turn-key="${CSS.escape(messageId)}"]`)
      if (target) {
        target.scrollIntoView({ block: "start", behavior: "instant" })
        finish("dom")
        return
      }
      const targetIndex = questionIds.indexOf(messageId)
      const mounted = [...root!.querySelectorAll<HTMLElement>("[data-turn-key]")]
        .map((turn) => questionIds.indexOf(turn.dataset.turnKey!))
        .filter((index) => index >= 0)
      // No timeout or retry budget: at a boundary, wait for host content changes
      // or user cancellation. An absent target may remain pending.
      if (mounted.length) direction = targetIndex > Math.max(...mounted) ? 1 : -1
      const before = root!.scrollTop
      root!.scrollBy({ top: direction * root!.clientHeight * 0.75, behavior: "instant" })
      if (root!.scrollTop !== before) schedule()
    }
    signal.addEventListener("abort", abort, { once: true })
    window.addEventListener(pageChangeEvent, conversationChanged)
    document.addEventListener("wheel", manual, { capture: true, passive: true })
    document.addEventListener("touchstart", manual, { capture: true, passive: true })
    document.addEventListener("pointerdown", manual, true)
    document.addEventListener("keydown", keyboard, true)
    void (async () => {
      try {
        if (await tryRevealQuestion(messageId, controller.signal)) {
          if (!stopped) finish("native")
          return
        }
      } catch (error) {
        if (stopped) return
        console.warn("[chatgpt-history-navigator] Falling back to DOM navigation:", error)
      }
      if (stopped) return
      console.info("[chatgpt-history-navigator] Using DOM navigation:", { messageId })
      mutations.observe(root, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["data-turn-key"],
      })
      resize.observe(root)
      if (root.firstElementChild) resize.observe(root.firstElementChild)
      advance()
    })()
  })
}

export function observeVisibleQuestions(
  questionByMessageId: ReadonlyMap<string, string>,
  onChange: (ids: Set<string>) => void,
): () => void {
  const targets = new Map<Element, string>()
  const visible = new Set<Element>()
  let previous = new Set<string>()
  let frame = 0
  const publish = () => {
    const ids = new Set(
      [...visible].flatMap((element) => {
        const id = targets.get(element)
        return id ? [id] : []
      }),
    )
    if (ids.size === previous.size && [...ids].every((id) => previous.has(id))) return
    previous = ids
    onChange(ids)
  }
  const intersection = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) visible.add(entry.target)
        else visible.delete(entry.target)
      }
      publish()
    },
    { rootMargin: "-16px 0px 0px 0px" },
  )
  const reconcile = () => {
    frame = 0
    const next = new Map<Element, string>()
    // The host's virtualized turn includes both the prompt and its replies.
    for (const turn of document.querySelectorAll<HTMLElement>("main [data-turn-key]")) {
      const id = questionByMessageId.get(turn.dataset.turnKey!)
      if (id) next.set(turn, id)
    }
    for (const element of targets.keys()) {
      if (next.has(element)) continue
      intersection.unobserve(element)
      targets.delete(element)
      visible.delete(element)
    }
    for (const [element, id] of next) {
      if (!targets.has(element)) intersection.observe(element)
      targets.set(element, id)
    }
    publish()
  }
  const mutations = new MutationObserver((records) => {
    const relevant = records.some(
      (record) =>
        record.type === "attributes" ||
        [...record.addedNodes, ...record.removedNodes].some(
          (node) =>
            node instanceof Element &&
            (node.matches("[data-turn-key]") || node.querySelector("[data-turn-key]")),
        ),
    )
    if (relevant && !frame) frame = requestAnimationFrame(reconcile)
  })
  mutations.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-turn-key"],
  })
  reconcile()
  return () => {
    cancelAnimationFrame(frame)
    mutations.disconnect()
    intersection.disconnect()
  }
}
const identitySchema = z.object({
  session: z.object({ user: z.object({ id: z.string().min(1) }) }),
})
let cachedBootstrapText: string | null | undefined
let userId: string | null = null

export function getConversationContextSnapshot(): string {
  const text = document.getElementById("client-bootstrap")?.textContent ?? null
  if (text !== cachedBootstrapText) {
    cachedBootstrapText = text
    userId = null
    if (text) {
      try {
        const parsed = identitySchema.safeParse(JSON.parse(text), { jitless: true })
        if (parsed.success) userId = parsed.data.session.user.id
      } catch {
        /* An unreadable identity must not reuse another user's cache. */
      }
    }
  }
  const match = location.pathname.match(/^(?:\/g\/[^/]+)?\/c\/([^/]+)\/?$/)
  const id = z.uuid().safeParse(match?.[1])
  return JSON.stringify([userId, id.success ? id.data : null])
}

export function subscribeConversationContext(onChange: () => void): () => void {
  window.addEventListener(pageChangeEvent, onChange)
  return () => window.removeEventListener(pageChangeEvent, onChange)
}

export function startConversationContextObserver(
  ctx: ContentScriptContext,
  beforeNotify: (userChanged: boolean) => void,
): () => void {
  let snapshot = getConversationContextSnapshot()
  const update = () => {
    const next = getConversationContextSnapshot()
    if (snapshot === next) return
    beforeNotify(JSON.parse(snapshot)[0] !== JSON.parse(next)[0])
    snapshot = next
    window.dispatchEvent(new Event(pageChangeEvent))
  }
  // WXT's Navigation API event fires before history.pushState commits the URL.
  ctx.addEventListener(window, "wxt:locationchange", () => {
    queueMicrotask(() => {
      if (ctx.isValid) update()
    })
  })
  let bootstrap = document.getElementById("client-bootstrap")
  const observer = new MutationObserver((records) => {
    const current = document.getElementById("client-bootstrap")
    if (current !== bootstrap || records.some((record) => current?.contains(record.target)))
      update()
    bootstrap = current
  })
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
  })
  return () => observer.disconnect()
}

const languageSchema = z
  .string()
  .trim()
  .refine((value) => {
    try {
      new Intl.Locale(value)
      return true
    } catch {
      return false
    }
  }, "Invalid language tag")

const bootstrapLocaleSchema = z.object({ locale: languageSchema })

export function getPageLanguage(): string {
  const bootstrap = document.getElementById("client-bootstrap")?.textContent
  if (bootstrap) {
    let data: unknown
    try {
      data = JSON.parse(bootstrap)
    } catch {
      // Invalid bootstrap JSON uses the next language source below.
    }
    const result = bootstrapLocaleSchema.safeParse(data)
    if (result.success) return result.data.locale
  }

  // Missing or invalid page data falls through in the requested priority order.
  const htmlLanguage = languageSchema.safeParse(document.documentElement.lang)
  if (htmlLanguage.success) return htmlLanguage.data
  return languageSchema.parse(navigator.language)
}

export function observePageLanguage(onChange: (language: string) => void): () => void {
  let language: string | undefined
  let bootstrap = document.getElementById("client-bootstrap")
  const update = () => {
    const next = getPageLanguage()
    if (next === language) return
    language = next
    onChange(next)
  }
  const observer = new MutationObserver((records) => {
    const current = document.getElementById("client-bootstrap")
    const changed =
      current !== bootstrap ||
      records.some(
        (record) =>
          (record.type === "attributes" && record.target === document.documentElement) ||
          current?.contains(record.target),
      )
    bootstrap = current
    if (changed) update()
  })
  // Observe replacement/insertion as well as edits to the bootstrap JSON.
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["lang"],
  })
  window.addEventListener("languagechange", update)
  update()

  return () => {
    observer.disconnect()
    window.removeEventListener("languagechange", update)
  }
}
