import { z } from "zod"
import { readFileSync } from "node:fs"

const milliseconds = z
  .number()
  .int()
  .min(1000)
  .max(30 * 60_000)
export const configSchema = z
  .object({
    conversationUrl: z.string().refine((value) => {
      try {
        const url = new URL(value)
        return (
          url.origin === "https://chatgpt.com" &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash &&
          /^(?:\/g\/[^/]+)?\/c\/[^/]+\/?$/.test(url.pathname) &&
          z.uuid().safeParse(url.pathname.split("/").filter(Boolean).at(-1)).success
        )
      } catch {
        return false
      }
    }, "Use an existing ChatGPT /c/<UUID> or /g/<id>/c/<UUID> conversation URL"),
    intervalMs: z.number().int().min(3000).max(60_000),
    maxRequests: z.number().int().min(1).max(100),
    maxPages: z.number().int().min(1).max(10),
    maxResources: z.number().int().min(1).max(10),
    maxResponseBytes: z
      .number()
      .int()
      .min(1024)
      .max(32 * 1024 * 1024),
    requestTimeoutMs: milliseconds,
    pageTimeoutMs: milliseconds,
    readyTimeoutMs: milliseconds,
    actionTimeoutMs: milliseconds,
    settleMs: milliseconds,
    suiteTimeoutMs: milliseconds,
  })
  .strict()
export type Config = z.infer<typeof configSchema>

export function loadConfig(): Config {
  let input: unknown
  try {
    input = JSON.parse(readFileSync("tests/chatgpt/config.local.json", "utf8"))
  } catch {
    throw new Error(
      "Copy tests/chatgpt/config.example.json to config.local.json, then set your conversation URL and limits",
    )
  }
  const parsed = configSchema.safeParse(input)
  if (!parsed.success)
    throw new Error(
      parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("\n"),
    )
  return parsed.data
}
