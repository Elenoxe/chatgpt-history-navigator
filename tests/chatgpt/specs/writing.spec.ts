import { test } from "../support/fixtures"

test.use({ needsHistory: true, resourceReads: true })

test("Existing Writing blocks", async ({ read }) => {
  await read(async () => {
    const { absent, messages, writingBlocksSchema } = globalThis.chatgpt
    let count = 0
    for (const message of messages()) {
      const raw = message.metadata.writing_blocks
      // WritingSection can render directive children without metadata or a file.
      if (raw == null) continue
      const parsed = writingBlocksSchema.safeParse(raw)
      if (!parsed.success) throw new Error("writing_blocks no longer satisfies production schema")
      for (const block of Object.values(parsed.data)) {
        if (block.current_version_number !== undefined)
          if (!Number.isFinite(Number(block.current_version_number)))
            throw new Error("Invalid Writing version")
        count++
      }
    }
    if (!count)
      return absent("No Writing blocks observed; generating new Writing is outside read-only scope")
    return `${count} stored blocks checked; current generation format not tested`
  })
})

test("Existing Writing revision metadata", async ({ read }) => {
  await read(async () => {
    const { absent, messages, z } = globalThis.chatgpt
    let count = 0
    for (const message of messages().filter((m) => m.role === "tool")) {
      let data
      try {
        const { text, parts } = message.content
        const source =
          typeof text === "string"
            ? text
            : Array.isArray(parts) && parts.every((part) => typeof part === "string")
              ? parts.join("")
              : ""
        data = JSON.parse(source)
      } catch {
        continue
      }
      if (!data?.library_file_id || data.status !== "created") continue
      if (
        typeof data.library_file_id !== "string" ||
        (data.current_content_file_id !== undefined &&
          (typeof data.current_content_file_id !== "string" || !data.current_content_file_id))
      )
        throw new Error("Writing tool file identity contract changed")
      if (!(Number.isSafeInteger(data.current_version_number) && data.current_version_number >= 0))
        throw new Error("Writing tool revision contract changed")
      const updates = message.metadata.resource_updates
      if (!data.current_content_file_id && updates !== undefined)
        if (
          !z
            .array(
              z.object({
                resource: z.object({
                  type: z.string(),
                  id: z.string(),
                  revision_id: z.string().optional(),
                }),
              }),
            )
            .safeParse(updates).success
        )
          throw new Error("Invalid Writing resource_updates")
      count++
    }
    if (!count) return absent("No stored Writing tool revision observed")
  })
})

test("Existing Writing content read", async ({ read }) => {
  await read(async () => {
    const { state, absent, messages, resourceContext, fetchWritingContent, writingBlocksSchema } =
      globalThis.chatgpt
    const blocks = messages()
      .flatMap((message) => {
        const parsed = writingBlocksSchema.safeParse(message.metadata.writing_blocks)
        return parsed.success ? Object.values(parsed.data) : []
      })
      .filter((block) => block.library_file_id || block.current_content_file_id)
    if (!blocks.length) return absent("No readable Writing file reference observed")
    const files = [
      ...new Map(
        blocks.map((block) => [block.library_file_id || block.current_content_file_id, block]),
      ).values(),
    ]
    for (const block of files.slice(0, state.options.maxResources)) {
      await fetchWritingContent(
        block.current_content_file_id ?? `file-inline-${block.library_file_id}`,
        resourceContext(),
        undefined,
        block.library_file_id,
      )
    }
    return `${Math.min(files.length, state.options.maxResources)}/${files.length} current files read; revision merge/rendering not tested`
  })
})
