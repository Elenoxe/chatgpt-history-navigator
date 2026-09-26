import { fetchFileDownloadUrl } from "../../../../src/platform/chatgpt/api"
import type { PreviewFileTarget } from "../../../../src/platform/chatgpt/api"
import { getPreviewContent, messageText } from "../../../../src/features/timeline/previewContent"
import { state, requireContract, unavailable, absent } from "./state"
import { messages, identity, resourceContext } from "./history"
type Resource = {
  kind: string
  target?: PreviewFileTarget
  src?: string
  mimeType?: string
  image?: boolean
}

export function resources(): Resource[] {
  const result: Resource[] = []
  for (const message of messages()) {
    const preview = getPreviewContent(message, "image")
    for (const attachment of preview.attachments) {
      if (attachment.href)
        result.push({ kind: "direct", src: attachment.href, mimeType: attachment.type })
      else if (attachment.id)
        result.push({ kind: "file", target: { fileId: attachment.id }, mimeType: attachment.type })
      else if (attachment.mountedLibraryId)
        result.push({
          kind: "mounted",
          target: {
            mountedLibraryId: attachment.mountedLibraryId,
            name: attachment.name,
            mimeType: attachment.type,
          },
        })
      else if (attachment.libraryId)
        result.push({
          kind: "library",
          target: { libraryId: attachment.libraryId },
          mimeType: attachment.type,
        })
    }
    for (const media of preview.media) {
      if (media.src)
        result.push({
          kind: "direct",
          src: media.src,
          mimeType: media.mimeType,
          image: media.image,
        })
      else if (media.fileId)
        result.push({
          kind: "file",
          target: { fileId: media.fileId },
          mimeType: media.mimeType,
          image: media.image,
        })
    }
    for (const match of messageText(message).matchAll(
      /\]\((sandbox:\/[^\s)]+|file-service:\/\/[^\s)]+)\)/g,
    )) {
      const url = match[1]!
      result.push(
        url.startsWith("sandbox:")
          ? {
              kind: "sandbox",
              target: {
                conversationId: identity().conversationId,
                messageId: message.id,
                sandboxPath: url.slice(8),
              },
            }
          : { kind: "file", target: { fileId: url.slice(15) } },
      )
    }
  }
  return [...new Map(result.map((r) => [JSON.stringify(r), r])).values()]
}
export async function loadResource(resource: Resource) {
  let url = resource.src
  if (resource.target) {
    requireContract(
      !("mountedLibraryId" in resource.target),
      "Materialize is excluded from read-only checks",
    )
    url = await fetchFileDownloadUrl({
      ...resource.target,
      projectId: resourceContext().projectId,
      scopeConversationId: identity().conversationId,
    })
  }
  // Plain attachment links also support HTTP and mailto in production.
  // They are not evidence of API drift; this probe only makes HTTPS reads.
  if (url && new URL(url).protocol !== "https:")
    absent("Attachment link uses a production-supported scheme outside HTTPS read scope")
  requireContract(
    url && new URL(url).protocol === "https:",
    "Observed resource lacks a usable HTTPS target",
  )
  if (
    resource.image ||
    resource.mimeType?.startsWith("image/") ||
    resource.mimeType?.startsWith("audio/") ||
    resource.mimeType?.startsWith("video/")
  ) {
    const blocked = await globalThis.chatgptCompatibilityRegisterRead(url)
    if (blocked) unavailable(blocked)
    const image = resource.image || resource.mimeType?.startsWith("image/")
    const element = image
      ? document.createElement("img")
      : document.createElement(resource.mimeType?.startsWith("audio/") ? "audio" : "video")
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => finish(new Error("[blocked] Media metadata/decode timed out")),
          state.options.actionTimeoutMs,
        )
        const finish = (error?: Error) => {
          clearTimeout(timer)
          listeners.abort()
          if (error) reject(error)
          else resolve()
        }
        const listeners = new AbortController()
        element.addEventListener("load", () => finish(), { signal: listeners.signal })
        element.addEventListener("loadedmetadata", () => finish(), { signal: listeners.signal })
        element.addEventListener(
          "error",
          () =>
            finish(
              new Error(
                "[blocked] Resource could not load; expiry/permission/network versus contract drift unresolved",
              ),
            ),
          { signal: listeners.signal },
        )
        if (element instanceof HTMLImageElement) element.referrerPolicy = "no-referrer"
        else element.preload = "metadata"
        element.src = url!
      })
    } finally {
      element.removeAttribute("src")
      if (element instanceof HTMLMediaElement) element.load()
    }
  } else {
    const response = await globalThis.chatgptCompatibilityFetch(url, {
      credentials: new URL(url).origin === location.origin ? "include" : "omit",
    })
    if (!response.ok)
      unavailable(
        `Resource HTTP ${response.status}: expiry/permissions versus contract drift unresolved`,
      )
    await response.arrayBuffer()
  }
}

export async function sampleResources(kind: string) {
  const candidates = resources().filter((resource) => resource.kind === kind)
  if (!candidates.length) absent(`No ${kind} resource discovered in this bounded sample`)
  for (const resource of candidates.slice(0, state.options.maxResources))
    await loadResource(resource)
  return `${Math.min(candidates.length, state.options.maxResources)}/${candidates.length} resources sampled`
}
