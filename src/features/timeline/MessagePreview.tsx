import { createContext, useContext, useEffect, useMemo } from "react"
import { skipToken, useQuery } from "@tanstack/react-query"
import { fetchWritingContent } from "@/platform/chatgpt/api"
import { PreviewContext } from "./PreviewContext"
import { useTranslation } from "react-i18next"
import Markdown, {
  defaultUrlTransform,
  type Components,
  type Options,
  type ExtraProps,
} from "react-markdown"
import remarkGfm from "remark-gfm"
import remarkMath from "remark-math"
import remarkDirective from "remark-directive"
import rehypeKatex from "rehype-katex"
import rehypeHighlight from "rehype-highlight"
import { visit } from "unist-util-visit"
import type { ConversationMessage } from "@/platform/chatgpt/conversation"
import { getPreviewContent, getWritingReferences, previewUrl } from "./previewContent"
import { ScrollFade } from "./ScrollFade"
import { PreviewFile } from "./PreviewFile"
import { PreviewReference } from "./PreviewReference"
import "katex/dist/katex.min.css"

// Only these parser-owned fields are needed to adapt ChatGPT's directives.
type DirectiveNode = {
  type: string
  name?: string
  value?: string
  attributes?: Record<string, string | null>
  children?: DirectiveNode[]
  position?: {
    start: { line: number; column: number; offset?: number }
    end: { line: number; column: number; offset?: number }
  }
  data?: { hName?: string; hProperties?: Record<string, unknown> }
}

function previewDirectives() {
  return (tree: DirectiveNode, file: { toString(): string }) => {
    visit(tree, (node) => {
      if (node.type === "containerDirective" && node.name === "writing") {
        node.data = {
          hName: "section",
          hProperties: {
            className: "preview-writing",
            "data-writing-id": node.attributes?.id,
            "data-writing-title": node.attributes?.title || node.attributes?.subject,
          },
        }
      } else if (node.type === "textDirective" && node.name === "previewReference") {
        node.data = {
          hName: "span",
          hProperties: { "data-preview-reference": node.children?.[0]?.value },
        }
      } else if (node.type.endsWith("Directive")) {
        // Unknown directives remain readable rather than silently dropping their syntax/content.
        node.type = "text"
        node.value = file.toString().slice(node.position?.start.offset, node.position?.end.offset)
        delete node.children
      }
    })
  }
}

const rehypePlugins: Options["rehypePlugins"] = [
  rehypeKatex,
  [rehypeHighlight, { detect: false, plainText: ["mermaid"] }],
]

const MarkdownContext = createContext<{
  title: boolean
  conversationId?: string | null
  message: ConversationMessage
  preview: ReturnType<typeof getPreviewContent>
  t: ReturnType<typeof useTranslation>["t"]
} | null>(null)

function WritingSection({ node, children }: React.ComponentProps<"section"> & ExtraProps) {
  const { message, conversationId, title } = useContext(MarkdownContext)!
  const context = useContext(PreviewContext)
  const id = String(node?.properties["data-writing-id"] ?? "")
  const blocks = message.metadata.writing_blocks as
    Record<string, Record<string, unknown>> | undefined
  const block = blocks?.[id]
  const libraryId = typeof block?.library_file_id === "string" ? block.library_file_id : undefined
  const saved = useQuery<{ fileId: string; version: number; content?: string }>({
    queryKey: ["preview", context.userId, "writing-revision", libraryId],
    queryFn: skipToken,
    staleTime: Infinity,
    gcTime: 30 * 60_000,
  }).data
  const savedIsLatest = saved && saved.version >= Number(block?.current_version_number ?? 0)
  const fileId = savedIsLatest
    ? saved.fileId
    : typeof block?.current_content_file_id === "string"
      ? block.current_content_file_id
      : libraryId
        ? `file-inline-${libraryId}`
        : undefined
  const query = useQuery({
    queryKey: ["preview", context.userId, "writing", libraryId, fileId, context],
    enabled:
      !title && !!fileId && !!context.userId && !(savedIsLatest && saved.content !== undefined),
    queryFn: ({ signal }) => fetchWritingContent(fileId!, context, signal, libraryId),
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  })
  useEffect(() => {
    if (query.error)
      console.error("[chatgpt-history-navigator] Failed to load Writing content:", query.error)
  }, [query.error])
  const content =
    savedIsLatest && saved.content !== undefined
      ? saved.content
      : fileId
        ? query.data
        : typeof block?.content === "string"
          ? block.content
          : undefined
  const heading = block?.title ?? block?.subject ?? node?.properties["data-writing-title"]
  const references =
    block?.content_references ??
    (message.metadata.content_references_by_file as Record<string, unknown> | undefined)?.[
      libraryId ?? ""
    ]
  const contentReferences =
    content === undefined ? [] : getWritingReferences(message, content, references)
  const memoryReferences = Array.isArray(message.metadata.conversation_context_citation_metadata)
    ? message.metadata.conversation_context_citation_metadata.filter(
        (item) =>
          item &&
          typeof item === "object" &&
          typeof item.citation_uuid === "string" &&
          contentReferences.some((reference) => reference.citation_uuid === item.citation_uuid),
      )
    : []
  return (
    <section className="preview-writing">
      {typeof heading === "string" && heading && (
        <header className="preview-writing-title">{heading}</header>
      )}
      {content !== undefined ? (
        <MessagePreview
          conversationId={conversationId}
          message={{
            ...message,
            content: { content_type: "text", parts: [content] },
            metadata: {
              content_references: contentReferences,
              conversation_context_citation_metadata: memoryReferences,
            },
          }}
        />
      ) : libraryId ? (
        <a
          href={`https://chatgpt.com/api/library/files/${encodeURIComponent(libraryId)}/download`}
          target="_blank"
          rel="noopener noreferrer"
        >
          {typeof heading === "string" ? heading : libraryId}
        </a>
      ) : (
        children
      )}
    </section>
  )
}

function fileTarget(
  url: string | undefined,
  title: boolean,
  conversationId: string | null | undefined,
  message: ConversationMessage,
) {
  if (title || !url) return
  if (url.startsWith("sandbox:/") && conversationId)
    return { conversationId, messageId: message.id, sandboxPath: url.slice("sandbox:".length) }
  if (url.startsWith("file-service://")) return { fileId: url.slice("file-service://".length) }
}

const components: Components = {
  a: ({ href, children }) => {
    const { title, conversationId, message } = useContext(MarkdownContext)!
    const target = fileTarget(href, title, conversationId, message)
    if (target) return <PreviewFile key={href} target={target} name={children} />
    const url = title ? undefined : previewUrl(href)
    return url ? (
      <a className="preview-link" href={url} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ) : (
      <span
        className={
          /^(app|plugin|skill):/.test(href ?? "")
            ? "preview-mention"
            : /^(sandbox|attachment):/.test(href ?? "")
              ? "preview-attachment"
              : undefined
        }
      >
        {children}
      </span>
    )
  },
  img: ({ src, alt }) => {
    const { title, conversationId, message, t } = useContext(MarkdownContext)!
    const target = fileTarget(src, title, conversationId, message)
    return target ? (
      <PreviewFile
        key={src}
        target={target}
        name={alt || t("timeline.preview.imageFallbackLabel")}
        image
      />
    ) : title || !src ? (
      <span>{alt}</span>
    ) : (
      <PreviewFile
        key={src}
        src={src}
        name={alt || t("timeline.preview.imageFallbackLabel")}
        image
      />
    )
  },
  span: ({ node, children, ...props }) => {
    const { title, message, preview } = useContext(MarkdownContext)!
    const index = node?.properties["data-preview-reference"]
    const reference = index === undefined ? undefined : preview.references[Number(index)]
    if (!title && reference?.kind === "source")
      return (
        <PreviewReference key={`${message.id}:${reference.citationUuid ?? index}`} {...reference} />
      )
    return reference ? (
      <span className={`preview-${reference.kind}`} title={reference.label}>
        {!title && reference.links.length
          ? reference.links.map((link, index) => (
              <span key={link.href}>
                {index > 0 && " · "}
                <a href={link.href} target="_blank" rel="noopener noreferrer">
                  {link.label}
                </a>
              </span>
            ))
          : reference.label}
      </span>
    ) : (
      <span {...props}>{children}</span>
    )
  },
  table: ({ children }) => {
    const { title, t } = useContext(MarkdownContext)!
    return title ? (
      <table>{children}</table>
    ) : (
      <ScrollFade horizontal label={t("timeline.preview.tableRegionLabel")}>
        <table>{children}</table>
      </ScrollFade>
    )
  },
  section: WritingSection,
  pre: ({ children, node }) => {
    const { title } = useContext(MarkdownContext)!
    if (title) return <span>{children}</span>
    const code = node?.children.find(
      (child) => child.type === "element" && child.tagName === "code",
    )
    const classes = code?.type === "element" ? code.properties.className : []
    const language = Array.isArray(classes)
      ? classes.find((value) => String(value).startsWith("language-"))
      : undefined
    return (
      <div className="preview-code-block">
        {language && <div className="preview-code-language">{String(language).slice(9)}</div>}
        <pre>{children}</pre>
      </div>
    )
  },
}

export function MessagePreview({
  message,
  title = false,
  conversationId,
}: {
  message: ConversationMessage
  title?: boolean
  conversationId?: string | null
}) {
  const { t } = useTranslation()
  const preview = useMemo(
    () =>
      getPreviewContent(
        message,
        t("timeline.preview.sourceFallbackLabel"),
        t("timeline.preview.imageFallbackLabel"),
      ),
    [message, t],
  )
  const remarkPlugins: Options["remarkPlugins"] = [
    remarkGfm,
    [remarkMath, { singleDollarTextMath: false }],
    remarkDirective,
    previewDirectives,
  ]
  return (
    <MarkdownContext.Provider value={{ title, conversationId, message, preview, t }}>
      <Markdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={title ? [] : rehypePlugins}
        components={components}
        skipHtml
        urlTransform={(url, key) =>
          /^(sandbox|file-service):/.test(url) ||
          (key === "href" && /^(app|plugin|skill|attachment):/.test(url))
            ? url
            : defaultUrlTransform(url)
        }
      >
        {preview.markdown ||
          (title
            ? preview.attachments.map((item) => item.name).join(", ") ||
              t("timeline.nonTextMessage")
            : "")}
      </Markdown>
      {!title && (
        <>
          {preview.references
            .filter((reference) => reference.inline === false)
            .map((reference, index) => (
              <PreviewReference key={reference.citationUuid ?? index} {...reference} />
            ))}
          {preview.media.map((media, index) =>
            media.src ? (
              <PreviewFile
                key={media.src}
                src={media.src}
                name={media.name}
                mimeType={media.mimeType}
                image={media.image}
              />
            ) : media.fileId ? (
              <PreviewFile
                key={media.fileId}
                target={{ fileId: media.fileId }}
                name={media.name}
                mimeType={media.mimeType}
                image={media.image}
              />
            ) : (
              <span key={index} className="preview-attachment">
                {media.name}
                {media.mimeType && <small> · {media.mimeType}</small>}
              </span>
            ),
          )}
          {preview.partFallbacks.map((part) => (
            <span key={part.label} className="preview-attachment">
              {part.label}
            </span>
          ))}
          {preview.attachments.map((attachment, index) =>
            !attachment.id && attachment.mountedLibraryId && !attachment.href ? (
              <PreviewFile
                key={attachment.mountedLibraryId}
                target={{
                  mountedLibraryId: attachment.mountedLibraryId,
                  name: attachment.name,
                  mimeType: attachment.type,
                }}
                name={attachment.name}
                mimeType={attachment.type}
              />
            ) : !attachment.id && attachment.libraryId && !attachment.href ? (
              <PreviewFile
                key={attachment.libraryId}
                target={{ libraryId: attachment.libraryId }}
                name={attachment.name}
                mimeType={attachment.type}
              />
            ) : attachment.id && !attachment.href ? (
              <PreviewFile
                key={attachment.id}
                target={{ fileId: attachment.id }}
                name={attachment.name}
                mimeType={attachment.type}
              />
            ) : (
              <span key={index} className="preview-attachment" title={attachment.type}>
                {attachment.href ? (
                  <a href={attachment.href} target="_blank" rel="noopener noreferrer">
                    {attachment.name}
                  </a>
                ) : (
                  attachment.name
                )}
                {attachment.type && <small> · {attachment.type}</small>}
              </span>
            ),
          )}
        </>
      )}
    </MarkdownContext.Provider>
  )
}
