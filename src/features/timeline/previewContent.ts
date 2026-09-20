import type { ConversationMessage } from "@/platform/chatgpt/conversation"
import type { PreviewFileTarget } from "@/platform/chatgpt/api"

export type PreviewReferenceData = {
  label: string
  kind: "mention" | "source"
  links: { label: string; href: string }[]
  files?: { target: PreviewFileTarget; name: string }[]
  excerpts?: string[]
  citationUuid?: string
  messageId?: string
  inline?: boolean
}

export function messageText(message: ConversationMessage) {
  if (!["text", "multimodal_text"].includes(message.content.content_type)) return ""
  return Array.isArray(message.content.parts)
    ? message.content.parts.filter((part): part is string => typeof part === "string").join("\n")
    : typeof message.content.text === "string"
      ? message.content.text
      : ""
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

export function parsePreviewReference(
  reference: Record<string, unknown>,
  sourceLabel: string,
): PreviewReferenceData {
  const items = [reference, ...records(reference.items)].flatMap((item) => {
    const file = record(item.fileItem)
    return [{ ...item, ...file }]
  })
  const label =
    [
      ...new Set(
        items
          .map((item) => text(item.title) || text(item.filename) || text(item.name))
          .filter(Boolean),
      ),
    ].join(" · ") ||
    text(reference.alt) ||
    sourceLabel
  const links = items
    .flatMap((item) => {
      const href =
        previewUrl(item.cloud_doc_url) ||
        previewUrl(record(item.extra).cloud_doc_url) ||
        previewUrl(item.internalHref) ||
        previewUrl(item.url)
      return href ? [{ label: text(item.title) || text(item.name) || label, href }] : []
    })
    .filter((item, index, all) => all.findIndex((other) => other.href === item.href) === index)
  const files = items
    .flatMap((item) => {
      const name = text(item.filename) || text(item.title) || text(item.name) || label
      const libraryId = text(item.library_file_id)
      const fileId = text(item.file_id)
      const isFileCitation =
        record(item.fff_metadata).file_reference_type === "file_citation" ||
        reference.type === "file" ||
        /^(?:filecite|\[citefilecite)/i.test(text(reference.matched_text).trim())
      const id = isFileCitation ? text(item.id) : ""
      const mountedLibraryId =
        text(item.mounted_library_file_id) ||
        [libraryId, id].find((value) => /^(?:file-library:)?external-/.test(value))
      const target: PreviewFileTarget | undefined = fileId
        ? { fileId }
        : mountedLibraryId
          ? { mountedLibraryId, name, mimeType: text(item.mime_type) }
          : libraryId
            ? { libraryId }
            : id &&
                !(
                  previewUrl(item.cloud_doc_url) ||
                  previewUrl(record(item.extra).cloud_doc_url) ||
                  previewUrl(item.internalHref) ||
                  previewUrl(item.url)
                )
              ? id.startsWith("file-")
                ? { fileId: id }
                : { libraryId: id }
              : undefined
      return target ? [{ target, name }] : []
    })
    .filter(
      (item, index, all) =>
        all.findIndex((other) => JSON.stringify(other.target) === JSON.stringify(item.target)) ===
        index,
    )
  const excerpts = items.flatMap((item) => {
    const snippet = text(item.quote) || text(item.snippet) || text(item.reason)
    const page = item.page_range_start
    const pointer = Object.keys(record(item.input_pointer)).length
      ? record(item.input_pointer)
      : record(record(item.fff_metadata).input_pointer)
    const line = pointer.line_range_start ?? item.line_range_start ?? item.start_line
    const lineEnd = pointer.line_range_end ?? item.line_range_end ?? item.end_line
    const range =
      typeof page === "number"
        ? `p. ${page}${item.page_range_end !== undefined && item.page_range_end !== page ? `–${item.page_range_end}` : ""}`
        : typeof line === "number"
          ? `L${line}${lineEnd !== undefined ? `–${lineEnd}` : ""}`
          : ""
    return [range, snippet].filter(Boolean)
  })
  return {
    label,
    kind: "source",
    links,
    files,
    excerpts: [...new Set(excerpts)],
    citationUuid: text(reference.citation_uuid) || undefined,
  }
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

export function getPreviewContent(
  message: ConversationMessage,
  sourceLabel: string,
  imageLabel: string,
) {
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
  type Reference = PreviewReferenceData
  const references: Reference[] = []
  const replacements: { start: number; end: number; index: number }[] = []
  const addReference = (
    start: unknown,
    end: unknown,
    label: string,
    kind: Reference["kind"],
    links: Reference["links"] = [],
  ) => {
    if (
      typeof start !== "number" ||
      typeof end !== "number" ||
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      end <= start ||
      end > source.length
    )
      return false
    replacements.push({ start, end, index: references.length })
    references.push({ label, kind, links })
    return true
  }
  const serialization = record(message.metadata.serialization_metadata)
  for (const symbol of records(serialization.custom_symbol_offsets)) {
    const start = symbol.startIndex
    const end = symbol.endIndex
    if (typeof start !== "number" || typeof end !== "number") continue
    addReference(start, end, source.slice(start, end), "mention")
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
    const metadata = records(message.metadata.conversation_context_citation_metadata).find(
      (item) => item.citation_uuid === reference.citation_uuid,
    )
    const parsed = parsePreviewReference(
      { ...reference, ...record(metadata?.citation) },
      sourceLabel,
    )
    if (addReference(reference.start_idx, reference.end_idx, parsed.label, "source")) {
      references[references.length - 1] = { ...parsed, messageId: message.id, inline: true }
    }
  }
  for (const metadata of records(message.metadata.conversation_context_citation_metadata)) {
    const reference = { ...metadata, ...record(metadata.citation) }
    const parsed = parsePreviewReference(reference, sourceLabel)
    if (parsed.citationUuid && references.some((item) => item.citationUuid === parsed.citationUuid))
      continue
    references.push({ ...parsed, messageId: message.id, inline: false })
  }
  let markdown = ""
  let cursor = 0
  for (const replacement of replacements.sort((a, b) => a.start - b.start || b.end - a.end)) {
    if (replacement.start < cursor) continue
    markdown += source.slice(cursor, replacement.start) + `:previewReference[${replacement.index}]`
    cursor = replacement.end
  }
  markdown += source.slice(cursor)

  const images = records(message.content.parts)
    .filter((part) => part.content_type === "image_asset_pointer")
    .map((part) => ({
      // Asset pointers require a separate authenticated resolution API; never use them as image URLs.
      src: /^https:\/\//i.test(text(part.asset_pointer)) ? text(part.asset_pointer) : undefined,
      fileId: /^file-service:\/\//.test(text(part.asset_pointer))
        ? text(part.asset_pointer).slice("file-service://".length)
        : undefined,
      alt: imageLabel,
    }))
  return {
    markdown: normalizeMath(markdown),
    references,
    attachments,
    images,
  }
}
