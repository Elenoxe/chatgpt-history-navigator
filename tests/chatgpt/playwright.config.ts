import { defineConfig } from "@playwright/test"
import { resolve } from "node:path"
import { loadConfig } from "./config"

// Listing tests is offline and needs no private conversation URL.
const settings =
  process.argv.includes("--list") || process.argv.includes("--help") ? undefined : loadConfig()
const output =
  process.env.CHATGPT_TEST_OUTPUT ??
  resolve(".chatgpt-compat/runs", new Date().toISOString().replace(/[:.]/g, "-"))
export default defineConfig({
  testDir: "./specs",
  testMatch: "*.spec.ts",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: settings
    ? settings.pageTimeoutMs +
      settings.readyTimeoutMs +
      settings.settleMs +
      (settings.maxPages + settings.maxResources * 3 + 4) *
        (settings.requestTimeoutMs + settings.intervalMs) +
      settings.actionTimeoutMs * 2
    : undefined,
  globalTimeout: settings?.suiteTimeoutMs,
  metadata: { runDirectory: output },
  outputDir: resolve(output, "artifacts"),
  reporter: [
    ["list"],
    ["html", { outputFolder: resolve(output, "report"), open: "never" }],
    ["json", { outputFile: resolve(output, "results.json") }],
  ],
})
