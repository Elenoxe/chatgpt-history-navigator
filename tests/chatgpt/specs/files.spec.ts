import { test } from "../support/fixtures"

test.use({ needsHistory: true, resourceReads: true })

test("Existing file resources", async ({ read }) => {
  await read(() => globalThis.chatgpt.sampleResources("file"))
})

test("Existing library resources", async ({ read }) => {
  await read(() => globalThis.chatgpt.sampleResources("library"))
})

test("Existing sandbox resources", async ({ read }) => {
  await read(() => globalThis.chatgpt.sampleResources("sandbox"))
})

test("Existing direct resources", async ({ read }) => {
  await read(() => globalThis.chatgpt.sampleResources("direct"))
})
