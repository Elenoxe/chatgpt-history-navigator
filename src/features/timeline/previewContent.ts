import type { ConversationMessage } from "@/platform/chatgpt/conversation"
export type PreviewMedia = {
  src?: string
  fileId?: string
  name: string
  mimeType?: string
  image: boolean
}

export type PreviewPartFallback = {
  label: string
}

export function messageText(message: ConversationMessage) {
  if (Array.isArray(message.content.parts)) {
    const parts = message.content.parts.map(partTextValue).filter(Boolean).join("\n")
    if (parts) return parts
  }
  return text(message.content.text)
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function records(value: unknown) {
  return Array.isArray(value) ? value.map(record) : []
}

function text(value: unknown) {
  return typeof value === "string" ? value : ""
}

function partType(part: Record<string, unknown>) {
  return text(part.content_type) || text(part.type)
}

function partTextValue(part: unknown) {
  if (typeof part === "string") return part
  const value = record(part)
  const kind = partType(value)
  return (
    text(value.text) ||
    (["text", "multimodal_text", "transcription", "audio_transcription"].includes(kind)
      ? text(value.content)
      : "")
  )
}

function partAssetPointer(part: Record<string, unknown>) {
  return (
    text(part.asset_pointer) ||
    text(part.assetPointer) ||
    text(part.file_id) ||
    text(part.fileId) ||
    text(part.url) ||
    text(part.src)
  )
}

function resolvePartAsset(pointer: string) {
  if (/^https:\/\//i.test(pointer)) return { src: pointer }
  if (/^file-service:\/\//i.test(pointer))
    return { fileId: pointer.slice("file-service://".length) }
  if (/^file-[^/#?]+$/i.test(pointer)) return { fileId: pointer }
}

function partMedia(part: unknown, imageLabel: string): PreviewMedia | undefined {
  const value = record(part)
  const kind = partType(value).toLowerCase()
  const mimeType = text(value.mime_type) || text(value.mimeType) || undefined
  const isImage = kind.includes("image") || !!mimeType?.toLowerCase().startsWith("image/")
  const isAudio = kind.includes("audio") || !!mimeType?.toLowerCase().startsWith("audio/")
  const isVideo = kind.includes("video") || !!mimeType?.toLowerCase().startsWith("video/")
  const isFile =
    kind === "file" ||
    kind.includes("file_") ||
    kind.includes("attachment") ||
    kind.includes("document")
  if (!isImage && !isAudio && !isVideo && !isFile) return
  const pointer = partAssetPointer(value)
  const asset = pointer ? resolvePartAsset(pointer) : undefined
  const name =
    text(value.name) ||
    text(value.filename) ||
    text(value.alt) ||
    (isImage ? imageLabel : mimeType || partType(value) || "attachment")
  return { ...asset, name, mimeType, image: isImage }
}

function getPartPreview(message: ConversationMessage, imageLabel: string) {
  const media: PreviewMedia[] = []
  const partFallbacks: PreviewPartFallback[] = []
  for (const part of Array.isArray(message.content.parts) ? message.content.parts : []) {
    if (typeof part === "string") continue
    const value = record(part)
    const kind = partType(value)
    if (!kind) continue
    const asset = partMedia(part, imageLabel)
    if (asset) {
      media.push(asset)
      continue
    }
    if (partTextValue(part)) continue
    if (["text", "multimodal_text", "transcription", "audio_transcription"].includes(kind)) continue
    const label =
      text(value.name) || text(value.filename) || text(value.title) || kind.replace(/[_-]+/g, " ")
    if (!partFallbacks.some((item) => item.label === label)) partFallbacks.push({ label })
  }
  return { media, partFallbacks }
}

export function getWritingReferences(
  message: ConversationMessage,
  content: string,
  scopedReferences: unknown,
) {
  if (Array.isArray(scopedReferences)) return records(scopedReferences)
  const original = messageText(message)
  // Parent offsets cannot be reused in an edited block. Match only verified citation markers
  // that still exist verbatim in the replacement; removed citations remain removed.
  return records(message.metadata.content_references).flatMap((reference) => {
    const marker = text(reference.matched_text)
    const start = reference.start_idx
    const end = reference.end_idx
    if (
      !marker ||
      typeof start !== "number" ||
      typeof end !== "number" ||
      original.slice(start, end) !== marker
    )
      return []
    const matches: Record<string, unknown>[] = []
    for (
      let offset = content.indexOf(marker);
      offset >= 0;
      offset = content.indexOf(marker, offset + marker.length)
    ) {
      matches.push({ ...reference, start_idx: offset, end_idx: offset + marker.length })
    }
    return matches
  })
}

// Metadata URLs bypass react-markdown, so validate them independently too.
export function previewUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return
  try {
    const url = new URL(value, "https://chatgpt.com")
    if (["https:", "http:", "mailto:"].includes(url.protocol)) return url.href
  } catch {
    /* An invalid URL remains a non-interactive label. */
  }
}

// ChatGPT also emits TeX delimiters. Do not rewrite examples inside code fences or spans.
function normalizeMath(markdown: string) {
  const tokens = /^ {0,3}(`{3,}|~{3,})[^\n]*(?:\n|$)|(`+)|\\([([])|^((?: {4}|\t)[^\n]*(?:\n|$))/gm
  let result = ""
  let cursor = 0
  for (let match = tokens.exec(markdown); match; match = tokens.exec(markdown)) {
    const start = match.index
    result += markdown.slice(cursor, start)
    let end = tokens.lastIndex
    if (match[4]) {
      result += match[0]
    } else if (match[1]) {
      const fence = match[1]
      const closing = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \\t]*(?:\\n|$)`, "gm")
      closing.lastIndex = end
      const close = closing.exec(markdown)
      end = close ? closing.lastIndex : markdown.length
      result += markdown.slice(start, end)
    } else if (match[2]) {
      const closing = new RegExp(`(?<!\x60)\x60{${match[2].length}}(?!\x60)`, "g")
      closing.lastIndex = end
      const close = closing.exec(markdown)
      end = close ? closing.lastIndex : end
      result += markdown.slice(start, end)
    } else {
      const block = match[3] === "["
      const close = markdown.indexOf(block ? "\\]" : "\\)", end)
      if (close < 0) result += match[0]
      else {
        const formula = markdown.slice(end, close)
        result += block ? `\n$$\n${formula}\n$$\n` : `$$${formula}$$`
        end = close + 2
      }
    }
    cursor = end
    tokens.lastIndex = end
  }
  return result + markdown.slice(cursor)
}

export function getPreviewContent(message: ConversationMessage, imageLabel: string) {
  const source = messageText(message)
  const attachments = [
    ...records(message.metadata.attachments),
    ...records(message.metadata.mounted_library_file_references),
  ]
    .map((attachment) => ({
      id: text(attachment.id) || text(attachment.file_id),
      libraryId: /^(?:file-library:)?external-/.test(text(attachment.library_file_id))
        ? ""
        : text(attachment.library_file_id),
      mountedLibraryId:
        text(attachment.mounted_library_file_id) ||
        (/^(?:file-library:)?external-/.test(text(attachment.library_file_id))
          ? text(attachment.library_file_id)
          : ""),
      href: previewUrl(attachment.download_url),
      name: text(attachment.name),
      type: text(attachment.mime_type),
    }))
    .filter(
      (attachment, index, items) =>
        attachment.name &&
        items.findIndex((other) =>
          attachment.id
            ? other.id === attachment.id
            : attachment.libraryId
              ? other.libraryId === attachment.libraryId
              : attachment.mountedLibraryId
                ? other.mountedLibraryId === attachment.mountedLibraryId
                : other.name === attachment.name,
        ) === index,
    )
  const mentions: string[] = []
  const replacements: { start: number; end: number; content: string }[] = []
  const addReplacement = (start: unknown, end: unknown, content: string) => {
    if (
      typeof start !== "number" ||
      typeof end !== "number" ||
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      end <= start ||
      end > source.length
    )
      return
    replacements.push({ start, end, content })
  }
  const serialization = record(message.metadata.serialization_metadata)
  for (const symbol of records(serialization.custom_symbol_offsets)) {
    const start = symbol.startIndex
    const end = symbol.endIndex
    if (typeof start !== "number" || typeof end !== "number") continue
    addReplacement(start, end, `:previewMention[${mentions.length}]`)
    mentions.push(source.slice(start, end))
  }
  for (const reference of records(message.metadata.content_references)) {
    // Offsets belong to the original message, before trimming or Markdown conversion.
    if (
      typeof reference.matched_text === "string" &&
      typeof reference.start_idx === "number" &&
      typeof reference.end_idx === "number" &&
      source.slice(reference.start_idx, reference.end_idx) !== reference.matched_text
    )
      continue
    addReplacement(reference.start_idx, reference.end_idx, "")
  }
  let markdown = ""
  let cursor = 0
  for (const replacement of replacements.sort((a, b) => a.start - b.start || b.end - a.end)) {
    if (replacement.start < cursor) continue
    markdown += source.slice(cursor, replacement.start)
    markdown += replacement.content
    cursor = replacement.end
  }
  markdown += source.slice(cursor)

  const { media, partFallbacks } = getPartPreview(message, imageLabel)
  return {
    markdown: normalizeMath(markdown),
    mentions,
    attachments,
    media,
    partFallbacks,
  }
}
