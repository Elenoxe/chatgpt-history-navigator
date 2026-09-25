import { z } from "zod"
import {
  ConversationDataError,
  parseConversation,
  parseConversationPage,
  parseApiResponse,
} from "./conversation"

export class ChatgptHttpError extends Error {
  constructor(readonly status: number) {
    super(`ChatGPT request failed (HTTP ${status})`)
    this.name = "ChatgptHttpError"
  }
}

async function requestJson(
  path: string,
  signal?: AbortSignal,
  accessToken?: string,
  options: RequestInit = {},
): Promise<unknown> {
  signal?.throwIfAborted()
  const response = await fetch(path, {
    ...options,
    credentials: "include",
    cache: "no-store",
    headers: {
      Accept: "application/json",
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...options.headers,
    },
    signal,
  })
  if (!response.ok) throw new ChatgptHttpError(response.status)
  const text = await response.text()
  signal?.throwIfAborted()
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new ConversationDataError("ChatGPT returned invalid JSON")
  }
}

// No global token cache. The caller owns these credentials for its loading operation;
// never persist them in Query data or forward them through the page bridge.
export async function fetchAccessToken(signal?: AbortSignal): Promise<string> {
  const data = await requestJson("/api/auth/session", signal)
  return parseApiResponse(z.object({ accessToken: z.string().min(1) }), data).accessToken
}

type RequestOptions = { accessToken: string; signal?: AbortSignal }

export type PreviewResourceContext = {
  userId: string | null
  conversationId?: string | null
  projectId?: string
  sharedId?: string
}
export type PreviewFileTarget = (
  | { fileId: string }
  | { libraryId: string }
  | { mountedLibraryId: string; name: string; mimeType: string }
  | { conversationId: string; messageId: string; sandboxPath: string }
) & { projectId?: string; sharedId?: string; scopeConversationId?: string }

export async function fetchFileDownloadUrl(target: PreviewFileTarget, signal?: AbortSignal) {
  if ("libraryId" in target)
    return `https://chatgpt.com/api/library/files/${encodeURIComponent(target.libraryId)}/download`
  let path: string
  const token = await fetchAccessToken(signal)
  if ("mountedLibraryId" in target) {
    const data = await requestJson(
      "/backend-api/files/library/mounted/materialize",
      signal,
      token,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          file_id: target.mountedLibraryId,
          name: target.name,
          mime_type: target.mimeType || null,
          index_for_retrieval: false,
        }),
      },
    )
    target = {
      fileId: parseApiResponse(z.object({ file_id: z.string().min(1) }), data).file_id,
      projectId: target.projectId,
      scopeConversationId: target.scopeConversationId,
    }
  }
  if ("fileId" in target) {
    const [fileId, query] = target.fileId.split("?")
    if (!fileId || /[/#]/.test(fileId)) throw new Error("Invalid ChatGPT file ID")
    const sharedId = target.sharedId || new URLSearchParams(query).get("shared_conversation_id")
    path = sharedId
      ? `/backend-api/share/${encodeURIComponent(sharedId)}/file/${encodeURIComponent(fileId)}`
      : `/backend-api/files/download/${encodeURIComponent(fileId)}`
    if (!sharedId) {
      const params = new URLSearchParams({ download_intent: "false" })
      if (target.projectId) params.set("gizmo_id", target.projectId)
      if (target.scopeConversationId)
        params.set("check_context_scopes_for_conversation_id", target.scopeConversationId)
      path += `?${params}`
    }
  } else {
    const id = z.uuid().parse(target.conversationId)
    if (!target.messageId || !target.sandboxPath.startsWith("/"))
      throw new Error("Invalid ChatGPT sandbox file")
    const query = new URLSearchParams({
      message_id: target.messageId,
      sandbox_path: target.sandboxPath,
    })
    path = target.sharedId
      ? `/backend-api/share/${encodeURIComponent(target.sharedId)}/file_from_message/${encodeURIComponent(target.messageId)}?${new URLSearchParams({ file_path: target.sandboxPath })}`
      : `/backend-api/conversation/${id}/interpreter/download?${query}`
  }
  const data = await requestJson(path, signal, token, {
    headers: target.projectId ? { "chatgpt-project-id": target.projectId } : {},
  })
  const { download_url } = parseApiResponse(z.object({ download_url: z.string().url() }), data)
  const url = new URL(download_url)
  if (url.protocol !== "https:") throw new Error("ChatGPT returned an unsafe download URL")
  return url.href
}

export async function fetchWritingContent(
  fileId: string,
  context: PreviewResourceContext,
  signal?: AbortSignal,
  libraryId?: string,
) {
  let url: string
  if (libraryId && !context.sharedId) {
    const token = await fetchAccessToken(signal)
    const data = await requestJson(
      `/backend-api/files/library/files/${encodeURIComponent(libraryId)}/content_url`,
      signal,
      token,
      { headers: context.projectId ? { "chatgpt-project-id": context.projectId } : {} },
    )
    url = parseApiResponse(z.object({ content_url: z.string().url() }), data).content_url
    if (new URL(url).protocol !== "https:")
      throw new ConversationDataError("Unsafe Writing content URL")
  } else
    url = await fetchFileDownloadUrl(
      {
        fileId,
        scopeConversationId: context.conversationId ?? undefined,
        projectId: context.projectId,
        sharedId: context.sharedId,
      },
      signal,
    )
  const response = await fetch(url, {
    signal,
    credentials: new URL(url).origin === location.origin ? "include" : "omit",
  })
  if (!response.ok) throw new ChatgptHttpError(response.status)
  return response.text()
}

function conversationPath(conversationId: string, kind: "mapping" | "paginated"): string {
  // IDs come from page URLs/events; reject malformed IDs before making a request.
  const id = z.uuid().parse(conversationId)
  return `/backend-api/${kind === "paginated" ? "conversations" : "conversation"}/${id}`
}

export async function fetchConversation(conversationId: string, options: RequestOptions) {
  const path = conversationPath(conversationId, "mapping")
  if (!options.accessToken.trim()) throw new Error("ChatGPT access token is required")
  const data = await requestJson(path, options.signal, options.accessToken)
  const history = parseConversation(data)
  if (history.conversationId !== conversationId) {
    throw new ConversationDataError("Conversation ID does not match request")
  }
  return history
}

export async function fetchConversationPage(
  conversationId: string,
  options: RequestOptions & { before?: string },
) {
  const before = options.before === undefined ? null : z.string().min(1).parse(options.before)
  const path = conversationPath(conversationId, "paginated")
  if (!options.accessToken.trim()) throw new Error("ChatGPT access token is required")
  const query = new URLSearchParams({ num_turns: "100", include_has_versions: "true" })
  if (before !== null) query.set("before", before)
  const data = await requestJson(
    `${path}${before !== null ? "/messages" : ""}?${query}`,
    options.signal,
    options.accessToken,
  )
  return parseConversationPage(data, conversationId, before)
}
