import type { Config } from "../../config"
import type {
  ConversationHistory,
  ConversationPage,
} from "../../../../src/platform/chatgpt/conversation"

export const state = {
  options: globalThis.chatgptCompatibilityOptions,
  token: undefined as string | undefined,
  mapping: undefined as ConversationHistory | undefined,
  firstPage: undefined as ConversationPage | undefined,
  nativeCaptures: [] as { ok: boolean; valid: boolean; pending: boolean; limited: boolean }[],
}
export function requireContract(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error(reason)
}
// Browser exceptions cross Playwright's serialization boundary as plain errors.
export function unavailable(reason: string): never {
  throw new Error("[blocked] " + reason)
}
export function absent(reason: string): never {
  throw new Error("[unobserved] " + reason)
}
export function skip(reason: string): never {
  throw new Error("[inapplicable] " + reason)
}

declare global {
  var chatgptCompatibilityOptions: Omit<Config, "conversationUrl">
  var chatgptCompatibilityFetch: typeof fetch
  var chatgptCompatibilityRegisterRead: (url: string) => Promise<string>
}
