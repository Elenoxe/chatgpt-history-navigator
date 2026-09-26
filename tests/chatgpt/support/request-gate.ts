import type { BrowserContext, Request, Response } from "@playwright/test"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import type { Config } from "../config"

export async function installReadGate(context: BrowserContext, settings: Config, path: string) {
  mkdirSync(dirname(path), { recursive: true })
  const state: { stopped: string; count: number; lastFinished: number; inFlight: boolean } =
    existsSync(path)
      ? JSON.parse(readFileSync(path, "utf8"))
      : { stopped: "", count: 0, lastFinished: Date.now(), inFlight: false }
  const save = () => writeFileSync(path, JSON.stringify(state, null, 2))
  // Playwright restarts workers after failures. Never reset a run's budget or stop flag.
  if (state.inFlight) state.stopped ||= "Previous worker ended during a read; no automatic retry"
  save()
  let queue = Promise.resolve()
  const registered = new Set<string>()
  // Register test resource URLs without copying tokens, signed URLs or bodies to reports.
  await context.exposeBinding("chatgptCompatibilityRegisterRead", (_, url: string) => {
    if (state.stopped) return state.stopped
    registered.add(url)
    return ""
  })
  // Throttle history GETs too: the host loader can issue multiple requests internally.
  // Static assets and unrelated host requests remain untouched.
  await context.route("**/*", async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const hostRead =
      url.origin === "https://chatgpt.com" &&
      /^\/(?:api\/auth\/session|api\/library\/files\/|backend-api\/(?:conversations?\/|files\/|share\/))/.test(
        url.pathname,
      )
    if (request.method() !== "GET" || (!hostRead && !registered.has(request.url()))) {
      await route.fallback()
      return
    }
    const previous = queue
    let release!: () => void
    queue = new Promise<void>((done) => {
      release = done
    })
    await previous
    let finished = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const complete = (failure?: string) => {
      if (finished) return
      finished = true
      if (failure) state.stopped ||= failure
      clearTimeout(timer)
      context.off("response", responseReceived)
      context.off("requestfinished", requestFinished)
      context.off("requestfailed", requestFailed)
      state.lastFinished = Date.now()
      state.inFlight = false
      save()
      release()
    }
    const responseReceived = (response: Response) => {
      if (response.request() !== request) return
      if ([401, 403, 429].includes(response.status()) || response.status() >= 500) {
        state.stopped = `HTTP ${response.status()}; no further reads this run`
        const retryAfter = response.headers()["retry-after"]
        if (retryAfter && /^[\w,: +-]{1,80}$/.test(retryAfter))
          state.stopped += `; Retry-After: ${retryAfter}`
        save()
      }
    }
    const requestFinished = (candidate: Request) => {
      if (candidate === request) complete()
    }
    const requestFailed = (candidate: Request) => {
      if (candidate === request) complete("Network read failed; no automatic retry")
    }
    try {
      await delay(Math.max(0, settings.intervalMs - (Date.now() - state.lastFinished)))
      if (!state.stopped && state.count >= settings.maxRequests)
        state.stopped = "Read request budget reached"
      if (state.stopped) {
        await route.abort("aborted")
        complete()
        return
      }
      state.count++
      state.inFlight = true
      save()
      context.on("response", responseReceived)
      context.on("requestfinished", requestFinished)
      context.on("requestfailed", requestFailed)
      timer = setTimeout(
        () => complete("Network read timed out; no automatic retry"),
        settings.requestTimeoutMs,
      )
      // Return the route handler before awaiting network events. Awaiting
      // request.response() inside this handler deadlocks Playwright's routing.
      await route.fallback()
    } catch {
      complete("Network routing failed; no automatic retry")
    }
  })

  return {
    get stopped() {
      return state.stopped
    },
    stop(reason: string) {
      state.stopped ||= reason
      save()
    },
  }
}
