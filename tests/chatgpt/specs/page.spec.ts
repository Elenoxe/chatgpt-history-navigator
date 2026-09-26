import { test } from "../support/fixtures"

test("Bootstrap identity", async ({ read }) => {
  await read(async () => {
    const { authenticate, getConversationContextSnapshot } = globalThis.chatgpt
    await authenticate()
    const [userId] = JSON.parse(getConversationContextSnapshot())
    if (!userId)
      throw new Error(
        "Authenticated page no longer exposes readable client-bootstrap.session.user.id",
      )
  })
})

test("Conversation route", async ({ read }) => {
  await read(async () => {
    const { authenticate, getConversationContextSnapshot } = globalThis.chatgpt
    await authenticate()
    const [, id] = JSON.parse(getConversationContextSnapshot())
    if (!id)
      throw new Error("Current URL no longer satisfies the production conversation route contract")
    return location.pathname.startsWith("/g/g-p-")
      ? "Project route"
      : location.pathname.startsWith("/g/")
        ? "GPT route"
        : "Ordinary conversation route"
  })
})

test.describe("History-backed DOM", () => {
  test.use({ needsHistory: true })
  test("Scroll container and turn IDs", async ({ read }) => {
    await read(async () => {
      const { state, absent, messages, populated } = globalThis.chatgpt
      populated()
      if (!document.querySelector("main [data-app-action-timeline-scroll]"))
        throw new Error("Conversation exists but scroll-container selector no longer matches")
      const turns = [...document.querySelectorAll<HTMLElement>("main [data-turn-key]")]
      if (!turns.length) throw new Error("Conversation exists but no turn keys are exposed")
      const ids = new Set(messages().map((m) => m.id))
      if (!turns.some((turn) => ids.has(turn.dataset.turnKey!))) {
        if (!state.mapping?.isHistoryComplete)
          return absent("Mounted turns are outside the bounded history sample")
        throw new Error("Mounted turn IDs do not match any fetched message")
      }
    })
  })
})

test("Native table-of-contents wrapper", async ({ read }) => {
  await read(async () => {
    const { absent } = globalThis.chatgpt
    const button = document.querySelector("button[data-toc-item-index]")
    if (!button)
      return absent(
        "Native TOC presence cannot be established independently; not assumed absent or compatible",
      )
    if (!button.closest("div.fixed"))
      throw new Error("TOC exists but the wrapper used by the production CSS no longer matches")
  })
})
