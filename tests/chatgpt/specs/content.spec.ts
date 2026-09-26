import { test } from "../support/fixtures"

test.use({ needsHistory: true })

test("Navigation message IDs", async ({ read }) => {
  await read(async () => {
    const { skip, users, z } = globalThis.chatgpt
    if (!users().length) return skip("No visible user messages in API sample")
    if (!users().every((m) => z.uuid().safeParse(m.id).success))
      throw new Error("Real user IDs no longer satisfy navigation's UUID contract")
  })
})

test("Text and multimodal parts", async ({ read }) => {
  await read(async () => {
    const { absent, skip, messages, getPreviewContent, messageText } = globalThis.chatgpt
    const sample = messages()
    if (!sample.length) return skip("API returned no messages")
    let textCount = 0,
      mediaCount = 0,
      labelCount = 0
    for (const message of sample) {
      const preview = getPreviewContent(message, "image")
      if (messageText(message)) textCount++
      mediaCount += preview.media.length
      labelCount += preview.partFallbacks.length
      // Some audio/transcription parts intentionally contain text without an asset.
      // A missing pointer alone is insufficient evidence of upstream breakage.
      labelCount += preview.media.filter((media) => !media.src && !media.fileId).length
    }
    if (!textCount && !mediaCount && !labelCount)
      return absent(
        "No independently recognizable text/media; new content format or unsupported sample",
      )
    return `Recognized text messages=${textCount}, media parts=${mediaCount}, supported labels=${labelCount}`
  })
})

test("Citation offsets", async ({ read }) => {
  await read(async () => {
    const { absent, messages, messageText } = globalThis.chatgpt
    let count = 0
    for (const message of messages()) {
      const references = message.metadata.content_references
      if (references == null) continue
      if (!Array.isArray(references)) throw new Error("content_references is no longer an array")
      for (const reference of references) {
        // Only offset-based references are consumed by previewContent.
        if (!reference || typeof reference !== "object") continue
        if (!("start_idx" in reference) && !("end_idx" in reference)) continue
        const { start_idx: start, end_idx: end, matched_text: marker } = reference
        const source = messageText(message)
        // Production checks stale markers before applying offset replacements.
        if (
          typeof marker === "string" &&
          typeof start === "number" &&
          typeof end === "number" &&
          source.slice(start, end) !== marker
        )
          continue
        if (!(
          Number.isInteger(start) &&
          Number.isInteger(end) &&
          start >= 0 &&
          end > start &&
          end <= source.length
        ))
          throw new Error("Invalid citation offsets")
        count++
      }
    }
    if (!count)
      return absent(
        "No offset citations observed; missing metadata alone cannot prove citations are absent",
      )
    return `${count} citation spans checked`
  })
})

test("Custom symbol offsets", async ({ read }) => {
  await read(async () => {
    const { absent, messages, z, messageText } = globalThis.chatgpt
    let count = 0
    for (const message of messages()) {
      const metadata = message.metadata.serialization_metadata as
        | {
            custom_symbol_offsets?: unknown
          }
        | undefined
      if (metadata?.custom_symbol_offsets === undefined) continue
      const offsets = z
        .array(
          z.object({
            startIndex: z.number().int().nonnegative(),
            endIndex: z.number().int().positive(),
          }),
        )
        .safeParse(metadata.custom_symbol_offsets)
      if (!offsets.success) throw new Error("Invalid custom_symbol_offsets structure")
      for (const item of offsets.data) {
        if (!(item.endIndex > item.startIndex && item.endIndex <= messageText(message).length))
          throw new Error("Symbol offsets exceed original text")
        count++
      }
    }
    if (!count) return absent("No custom-symbol offsets observed")
  })
})

test("Attachment metadata", async ({ read }) => {
  await read(async () => {
    const { absent, messages } = globalThis.chatgpt
    let count = 0
    for (const message of messages()) {
      for (const key of ["attachments", "mounted_library_file_references"]) {
        const items = message.metadata[key]
        if (items == null) continue
        if (!Array.isArray(items)) throw new Error(`${key} is no longer an array`)
        for (const item of items) {
          if (!item || typeof item !== "object") continue
          if (!(item && typeof item === "object" && typeof item.name === "string" && !!item.name))
            throw new Error("Observed attachment lacks the name consumed by previews")
          // Production supports name-only attachments; download identity is optional.
          count++
        }
      }
    }
    if (!count)
      return absent("No attachment metadata observed; no claim about unrecognized host formats")
  })
})
