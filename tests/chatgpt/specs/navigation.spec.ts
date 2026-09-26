import { test } from "../support/fixtures"

test.use({ needsHistory: true })

test("Native virtual-list methods", async ({ read }) => {
  await read(async () => {
    const { populated, findNavigation } = globalThis.chatgpt
    populated()
    if (!findNavigation()) throw new Error("getEntryGeometry / scrollToKey no longer discoverable")
  })
})

test("Native history loader signature", async ({ read }) => {
  await read(async () => {
    const { identity, populated, findLoader } = globalThis.chatgpt
    populated()
    const loader = findLoader(identity().conversationId)
    if (!loader)
      throw new Error(
        loader === undefined
          ? "Conversation component props contract not found"
          : "Loader source signature missing or ambiguous",
      )
  })
})

test("Unloaded history + native loader", async ({ read }) => {
  await read(async () => {
    const { navigate } = globalThis.chatgpt
    return navigate("unloaded")
  })
})

test("Loaded but unmounted native navigation", async ({ read }) => {
  await read(async () => {
    const { navigate } = globalThis.chatgpt
    return navigate("virtual")
  })
})

test("Mounted native navigation", async ({ read }) => {
  await read(async () => {
    const { navigate } = globalThis.chatgpt
    return navigate("mounted")
  })
})
