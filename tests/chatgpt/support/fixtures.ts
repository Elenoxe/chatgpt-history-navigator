import { test as base, expect } from "@playwright/test"
import type { Page } from "@playwright/test"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { loadConfig } from "../config"
import { installReadGate } from "./request-gate"
type Read = <T>(callback: () => T | Promise<T>) => Promise<T>
type Session = { page: Page; gate: Awaited<ReturnType<typeof installReadGate>>; ready: boolean }

export const test = base.extend<
  { needsHistory: boolean; resourceReads: boolean; read: Read },
  { session: Session }
>({
  needsHistory: [false, { option: true }],
  resourceReads: [false, { option: true }],
  session: [
    async ({ playwright }, use, workerInfo) => {
      if (workerInfo.config.workers !== 1 || workerInfo.project.retries !== 0)
        throw new Error("Live compatibility tests require --workers=1 and --retries=0")
      const config = loadConfig()
      const output = String(workerInfo.config.metadata.runDirectory)
      const context = await playwright.chromium.launchPersistentContext(
        resolve(".chatgpt-compat/profile"),
        {
          headless: false,
          viewport: { width: 1440, height: 1000 },
          serviceWorkers: "block",
        },
      )
      try {
        const gate = await installReadGate(context, config, resolve(output, "network.json"))
        const page = context.pages()[0] ?? (await context.newPage())
        const { conversationUrl, ...limits } = config
        let ready = false
        if (!gate.stopped) {
          await page.addInitScript({
            content: `globalThis.chatgptCompatibilityOptions = ${JSON.stringify(limits)};\n${await readFile(resolve(".chatgpt-compat/probe.js"), "utf8")}`,
          })
          try {
            const response = await page.goto(conversationUrl, {
              waitUntil: "domcontentloaded",
              timeout: config.pageTimeoutMs,
            })
            if (response && response.status() >= 400) gate.stop(`Page HTTP ${response.status()}`)
            await page.waitForFunction(() => !!document.querySelector("main"), undefined, {
              timeout: config.readyTimeoutMs,
            })
            await page.waitForTimeout(config.settleMs)
            ready = true
          } catch {
            gate.stop("Page not ready: login, challenge, network or bootstrap unavailable")
          }
        }
        await use({ page, gate, ready })
      } finally {
        await context.close()
      }
    },
    { scope: "worker" },
  ],
  read: async ({ session, needsHistory, resourceReads }, use, testInfo) => {
    const { page, gate, ready } = session
    test.skip(!ready || !!gate.stopped, gate.stopped || "Page not ready")
    expect(await page.evaluate(() => !!globalThis.chatgpt), "Browser adapter loaded").toBe(true)
    await use(async (callback) => {
      try {
        if (needsHistory) await page.evaluate(() => globalThis.chatgpt.prepareHistory())
        const value = await page.evaluate(callback)
        if (typeof value === "string")
          testInfo.annotations.push({ type: "sample", description: value })
        return value
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const skip = message.match(/\[(blocked|unobserved|inapplicable)\] ([^\n]*)/)
        const http = message.match(/ChatGPT request failed \(HTTP (\d+)\)/)
        const status = Number(http?.[1])
        const unavailable =
          [401, 403, 429].includes(status) || status >= 500 || (resourceReads && !!http)
        const timeout = /TimeoutError|AbortError|Failed to fetch|NetworkError/.test(message)
        if (skip || unavailable || timeout) {
          const reason =
            skip?.[2] ??
            (gate.stopped || "Network, permissions or time budget prevented this check")
          testInfo.annotations.push({ type: skip?.[1] ?? "blocked", description: reason })
          test.skip(true, reason)
        }
        throw error
      }
    })
  },
})
export { expect } from "@playwright/test"
