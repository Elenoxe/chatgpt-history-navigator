import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import { createInterface } from "node:readline/promises"
import { build } from "esbuild"
import { chromium } from "@playwright/test"

const args = process.argv.slice(2)
const root = resolve(".chatgpt-compat")
await mkdir(root, { recursive: true })
if (args.includes("--login")) {
  const context = await chromium.launchPersistentContext(resolve(root, "profile"), {
    headless: false,
  })
  const input = createInterface({ input: process.stdin, output: process.stdout })
  try {
    await (context.pages()[0] ?? (await context.newPage())).goto("https://chatgpt.com/")
    await input.question("Log in manually, then press Enter here to save and close. ")
  } finally {
    input.close()
    await context.close()
  }
  process.exit(0)
}
await build({
  entryPoints: ["tests/chatgpt/support/browser/index.ts"],
  outfile: resolve(root, "probe.js"),
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "chrome120",
  // Redirect only bundled adapter fetch calls through the read-only gate.
  define: { fetch: "globalThis.chatgptCompatibilityFetch" },
})
if (args.includes("--build-only")) {
  console.log("Browser helpers built offline; no browser or server requests.")
  process.exit(0)
}
const output = resolve(root, "runs", new Date().toISOString().replace(/[:.]/g, "-"))
await mkdir(output, { recursive: true })
const require = createRequire(import.meta.url)
const result = spawnSync(
  process.execPath,
  [
    require.resolve("@playwright/test/cli"),
    "test",
    "-c",
    "tests/chatgpt/playwright.config.ts",
    ...args,
  ],
  { stdio: "inherit", env: { ...process.env, CHATGPT_TEST_OUTPUT: output } },
)
if (result.error) throw result.error
process.exit(result.status ?? 1)
