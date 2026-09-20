import { useContext, useEffect, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { fetchConversationSources } from "@/platform/chatgpt/api"
import { PreviewContext } from "./PreviewContext"
import { PreviewFile } from "./PreviewFile"
import { parsePreviewReference, type PreviewReferenceData } from "./previewContent"

export function PreviewReference({
  label,
  links,
  files = [],
  excerpts = [],
  citationUuid,
  messageId,
}: PreviewReferenceData) {
  const [expanded, setExpanded] = useState(false)
  const context = useContext(PreviewContext)
  const query = useQuery({
    queryKey: ["preview", context.userId, "sources", context.conversationId, messageId],
    enabled:
      expanded && !!citationUuid && !!context.conversationId && !!messageId && !!context.userId,
    queryFn: ({ signal }) => fetchConversationSources(context.conversationId!, messageId!, signal),
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  })
  useEffect(() => {
    if (query.error)
      console.error("[chatgpt-history-navigator] Failed to load citation details:", query.error)
  }, [query.error])
  const source = query.data?.find((item) => item.citation_uuid === citationUuid)
  if (source) ({ links, files = [], excerpts = [] } = parsePreviewReference(source, label))
  return (
    <span className="preview-source">
      <button type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
        {label}
      </button>
      {expanded && (
        <span className="preview-source-details">
          {links.map((link) => (
            <a key={link.href} href={link.href} target="_blank" rel="noopener noreferrer">
              <span>{link.label}</span>
              <small>{link.href}</small>
            </a>
          ))}
          {files.map((file) => (
            <PreviewFile key={JSON.stringify(file.target)} target={file.target} name={file.name} />
          ))}
          {excerpts.map((excerpt) => (
            <span className="preview-reference-excerpt" key={excerpt}>
              {excerpt}
            </span>
          ))}
          {!links.length && !files.length && !excerpts.length && label}
        </span>
      )}
    </span>
  )
}
