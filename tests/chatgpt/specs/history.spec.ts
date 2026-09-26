import { test } from "../support/fixtures"
test.use({ needsHistory: false })

test("Session authentication", async ({ read }) => {
  await read(async () => {
    const { authenticate } = globalThis.chatgpt
    await authenticate()
    return "Session returned a usable token (not exported or persisted)"
  })
})

test("Mapping history endpoint", async ({ read }) => {
  await read(async () => {
    const { mappingHistory } = globalThis.chatgpt
    await mappingHistory()
    return "Mapping schema and active ancestor chain accepted"
  })
})

test("Paginated history endpoint", async ({ read }) => {
  await read(async () => {
    const { paginatedHistory } = globalThis.chatgpt
    await paginatedHistory()
    return "Initial paginated history accepted"
  })
})

test("Previous-page cursor", async ({ read }) => {
  await read(async () => {
    const { state, unavailable, skip, identity, fetchConversationPage, paginatedHistory } =
      globalThis.chatgpt
    await paginatedHistory()
    if (!state.firstPage || !state.token)
      return unavailable("Initial history read did not return a usable page")
    if (!state.firstPage.previousCursor) return skip("Server explicitly reports no previous page")
    let cursor: string | null = state.firstPage.previousCursor
    const seen = new Set<string>()
    let pages = 0
    while (cursor && pages < state.options.maxPages) {
      if (seen.has(cursor)) throw new Error("History cursor repeated")
      seen.add(cursor)
      const page = await fetchConversationPage(identity().conversationId, {
        accessToken: state.token,
        before: cursor,
      })
      pages++
      cursor = page.previousCursor
    }
    return `${pages} earlier pages accepted; ${cursor ? "more history remains (bounded sample, not full-history proof)" : "server reports start of history"}`
  })
})

test("Original host fetch history capture", async ({ read }) => {
  await read(async () => {
    const { state, unavailable, absent } = globalThis.chatgpt
    if (!state.nativeCaptures.length)
      return absent("No original history fetch observed; direct API probes do not count")
    const deadline = performance.now() + state.options.requestTimeoutMs
    while (state.nativeCaptures.some((c) => c.pending) && performance.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 100))
    if (state.nativeCaptures.some((c) => c.pending || c.limited))
      return unavailable("Native capture exceeded read time/byte budget")
    if (!state.nativeCaptures.some((c) => c.ok))
      return unavailable("Observed native history requests did not succeed")
    if (!state.nativeCaptures.filter((c) => c.ok).every((c) => c.valid))
      throw new Error("Native history response incompatible with current MIME/schema/URL contract")
  })
})
