import {
  parseConversation,
  parseConversationPage,
} from "../../../../src/platform/chatgpt/conversation"
import { state, unavailable } from "./state"
const nativeFetch = window.fetch.bind(window)
let cachedSession: Response | undefined
// Observe original host requests before navigation. Never alter their responses.
window.fetch = function (input, init) {
  const pending = nativeFetch(input, init)
  try {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href)
    const method = init?.method ?? (input instanceof Request ? input.method : "GET")
    const match = url.pathname.match(
      /^\/backend-api\/(conversation|conversations)\/([\da-f-]{36})(\/messages)?$/i,
    )
    if (
      url.origin === location.origin &&
      method === "GET" &&
      match &&
      !(match[1] === "conversation" && match[3])
    ) {
      void pending
        .then(async (response) => {
          const capture = { ok: response.ok, valid: false, pending: true, limited: false }
          state.nativeCaptures.push(capture)
          try {
            if (!response.ok) return
            if (!response.headers.get("content-type")?.includes("application/json")) return
            const reader = response.clone().body?.getReader()
            if (!reader) return
            let text = "",
              bytes = 0
            const decoder = new TextDecoder()
            const timer = setTimeout(() => {
              capture.limited = true
              void reader.cancel().catch(() => {})
            }, state.options.requestTimeoutMs)
            try {
              while (true) {
                const part = await reader.read()
                if (part.done) break
                bytes += part.value.byteLength
                if (bytes > state.options.maxResponseBytes) {
                  capture.limited = true
                  void reader.cancel().catch(() => {})
                  return
                }
                text += decoder.decode(part.value, { stream: true })
              }
              text += decoder.decode()
            } finally {
              clearTimeout(timer)
              reader.releaseLock()
            }
            if (capture.limited) return
            const value: unknown = JSON.parse(text)
            if (match[1] === "conversation") parseConversation(value)
            else parseConversationPage(value, match[2]!, url.searchParams.get("before"))
            capture.valid = true
          } catch {
            /* Recorded as an incompatible capture, never disrupt the host. */
          } finally {
            capture.pending = false
          }
        })
        .catch(() => {})
    }
  } catch {
    /* Network observation is diagnostic only. */
  }
  return pending
}

globalThis.chatgptCompatibilityFetch = async (input, init = {}) => {
  const url = new URL(input instanceof Request ? input.url : String(input), location.href)
  const method = init.method ?? (input instanceof Request ? input.method : "GET")
  if (method.toUpperCase() !== "GET" || url.protocol !== "https:")
    throw new Error("Read-only probe refused a non-GET or non-HTTPS request")
  const session = url.origin === location.origin && url.pathname === "/api/auth/session"
  if (session && cachedSession) return cachedSession.clone()
  const blocked = await globalThis.chatgptCompatibilityRegisterRead(url.href)
  if (blocked) unavailable(blocked)
  const response = await nativeFetch(input, {
    ...init,
    signal: AbortSignal.any([
      init.signal ?? new AbortController().signal,
      AbortSignal.timeout(state.options.requestTimeoutMs),
    ]),
  })
  // Bound memory and response consumption; preserve the real response status and headers.
  const reader = response.body?.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > state.options.maxResponseBytes) {
          await reader.cancel()
          unavailable("Response exceeds configured byte budget")
        }
        chunks.push(value)
      }
    } finally {
      reader.releaseLock()
    }
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  const buffered = new Response([204, 205, 304].includes(response.status) ? null : bytes, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
  if (session && response.ok) cachedSession = buffered.clone()
  return buffered
}
