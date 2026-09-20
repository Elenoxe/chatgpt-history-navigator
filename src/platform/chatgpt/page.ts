import { z } from "zod"
import type { ContentScriptContext } from "wxt/utils/content-script-context"
import {
  tryRevealQuestion,
  requestQuestionHistory,
  isNativeNavigationPending,
  cancelNativeNavigation,
} from "./bridge"

const pageChangeEvent = "chatgpt-history-navigator:pagechange"

export function hideNativeTimeline(): () => void {
  const style = document.createElement("style")
  // Hide the native TOC's fixed wrapper, keeping its React navigation state intact.
  // A page-level rule also covers TOCs mounted after history finishes loading.
  style.textContent = "div.fixed:has(button[data-toc-item-index]) { display: none !important; }"
  document.head.append(style)
  return () => style.remove()
}

// DOM is used only for navigation and reading position; content stays in the API cache.
export async function scrollToQuestion(messageId: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  const id = CSS.escape(messageId)
  const path = location.pathname
  await new Promise<void>((resolve, reject) => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    let nativeAttempted = false
    let nativeAccepted = false
    let root: HTMLElement | null = null
    let observedMain: HTMLElement | null = null
    let historyLoad: "idle" | "pending" | "complete" = "idle"
    const historyController = new AbortController()
    const mutations = new MutationObserver(() => schedule(0))
    const resize = new ResizeObserver(() => schedule(0))
    const cleanup = () => {
      stopped = true
      historyController.abort()
      const nativePending = nativeAccepted && isNativeNavigationPending(messageId)
      cancelNativeNavigation(messageId)
      if (nativePending && root) {
        root.scrollTo({ top: root.scrollTop, left: root.scrollLeft, behavior: "instant" })
      }
      clearTimeout(timer)
      mutations.disconnect()
      resize.disconnect()
      signal.removeEventListener("abort", abort)
      document.removeEventListener("wheel", onManualScroll, true)
      document.removeEventListener("touchstart", onManualScroll, true)
      document.removeEventListener("pointerdown", onPointerDown, true)
      document.removeEventListener("keydown", onKeyDown, true)
    }
    const abort = () => {
      cleanup()
      reject(signal.reason)
    }
    const cancel = () => {
      cleanup()
      resolve()
    }
    const fail = (error: unknown) => {
      cleanup()
      reject(error)
    }
    const onManualScroll = (event: Event) => {
      if (root && event.composedPath().includes(root)) cancel()
    }
    const onPointerDown = (event: PointerEvent) => {
      // Clicking/dragging the conversation, including its scrollbar, takes over.
      if (root && event.composedPath().includes(root)) cancel()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" && (!root || !event.composedPath().includes(root))) return
      if (
        ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", "Escape", " "].includes(
          event.key,
        )
      )
        cancel()
    }
    function schedule(delay: number) {
      if (stopped) return
      clearTimeout(timer)
      timer = setTimeout(advance, delay)
    }
    function finish(main: HTMLElement) {
      cleanup()
      const message = main.querySelector<HTMLElement>(`[data-message-id="${id}"]`)
      if (message && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
        message.animate(
          [
            { backgroundColor: "color-mix(in srgb, currentColor 10%, transparent)" },
            { backgroundColor: "transparent" },
          ],
          { duration: 700, easing: "ease-out" },
        )
      }
      resolve()
    }
    function advance() {
      if (stopped) return
      if (location.pathname !== path) {
        cancel()
        return
      }
      const main = document.querySelector<HTMLElement>("main")
      root = main
      while (root && !/^(auto|scroll)$/.test(getComputedStyle(root).overflowY))
        root = root.parentElement
      if (main !== observedMain) {
        mutations.disconnect()
        resize.disconnect()
        observedMain = main
        if (main) {
          mutations.observe(main, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ["data-message-id", "data-turn-id-container"],
          })
          resize.observe(main)
        }
      }
      if (main && root) {
        const placeholder = main.querySelector<HTMLElement>(`[data-turn-id-container="${id}"]`)
        if (!placeholder && historyLoad === "idle") {
          historyLoad = "pending"
          void requestQuestionHistory(messageId, historyController.signal)
            .then((loaded) => {
              if (stopped) return
              if (!loaded) {
                fail(new Error("Native targeted history loading is unavailable"))
                return
              }
              historyLoad = "complete"
              schedule(0)
            })
            .catch((error) => {
              if (stopped) return
              fail(error)
            })
        }
        // Let the native targeted request finish without competing pagination
        // or jumping to the top while the reader is waiting.
        if (historyLoad === "pending") {
          schedule(1000)
          return
        }
        if (!nativeAttempted && (placeholder || historyLoad === "complete")) {
          nativeAttempted = true
          // Also replace the native target when it was already mounted: an old
          // host navigation must not keep aligning an earlier question.
          nativeAccepted = tryRevealQuestion(messageId)
        }
        // Observe the host's request lifecycle, not an arbitrary wait deadline.
        // Its own completion/expiry hands control back without failing our jump.
        if (nativeAccepted && isNativeNavigationPending(messageId)) {
          schedule(100)
          return
        }
        const message = main.querySelector<HTMLElement>(`[data-message-id="${id}"]`)
        if (message) {
          const bounds = message.getBoundingClientRect()
          const visibleArea = root.getBoundingClientRect()
          if (
            nativeAccepted &&
            bounds.bottom > visibleArea.top &&
            bounds.top < visibleArea.bottom
          ) {
            finish(main)
            return
          }
          const turn = message.closest<HTMLElement>("[data-turn-id]") ?? message
          turn.scrollIntoView({ block: "start", behavior: "instant" })
          const rect = message.getBoundingClientRect()
          const viewport = root.getBoundingClientRect()
          // Instant scrolling is synchronous. Do not wait for rAF, which can be
          // suspended in hidden tabs even after the target has been positioned.
          if (rect.bottom > viewport.top && rect.top < viewport.bottom) {
            finish(main)
            return
          }
        } else if (placeholder) {
          const rect = placeholder.getBoundingClientRect()
          const viewport = root.getBoundingClientRect()
          if (rect.bottom <= viewport.top || rect.top >= viewport.bottom) {
            placeholder.scrollIntoView({ block: "center", behavior: "instant" })
          }
        }
      }
      // DOM/size changes advance immediately. This check also discovers replaced
      // containers and delayed mounts without paginating unrelated history.
      schedule(1000)
    }
    signal.addEventListener("abort", abort, { once: true })
    document.addEventListener("wheel", onManualScroll, { capture: true, passive: true })
    document.addEventListener("touchstart", onManualScroll, { capture: true, passive: true })
    document.addEventListener("pointerdown", onPointerDown, true)
    document.addEventListener("keydown", onKeyDown, true)
    advance()
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
    for (const message of document.querySelectorAll<HTMLElement>("main [data-message-id]")) {
      const id = questionByMessageId.get(message.dataset.messageId!)
      if (id) next.set(message.closest("[data-turn-id]") ?? message, id)
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
            (node.matches("[data-message-id]") || node.querySelector("[data-message-id]")),
        ),
    )
    if (relevant && !frame) frame = requestAnimationFrame(reconcile)
  })
  mutations.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-message-id"],
  })
  reconcile()
  return () => {
    cancelAnimationFrame(frame)
    mutations.disconnect()
    intersection.disconnect()
  }
}
const identitySchema = z.object({ user: z.object({ id: z.string().min(1) }) })
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
        if (parsed.success) userId = parsed.data.user.id
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
