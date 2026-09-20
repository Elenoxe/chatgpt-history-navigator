import { z } from "zod"
import type { ConversationHistory } from "./conversation"

export const writingBlocksSchema = z.record(
  z.string(),
  z.looseObject({
    content: z.string().optional(),
    title: z.string().optional(),
    subject: z.string().optional(),
    library_file_id: z.string().optional(),
    current_content_file_id: z.string().optional(),
  }),
)
export type WritingBlocks = z.infer<typeof writingBlocksSchema>
const filePatchSchema = z.object({
  status: z.literal("created"),
  library_file_id: z.string().min(1),
  current_content_file_id: z.string().min(1).optional(),
  current_version_number: z.number().int().nonnegative(),
})

export function mergeWritingBlocks(previous: unknown, patch: WritingBlocks): WritingBlocks {
  const blocks =
    previous && typeof previous === "object" && !Array.isArray(previous)
      ? (previous as WritingBlocks)
      : {}
  return {
    ...blocks,
    ...Object.fromEntries(
      Object.entries(patch).map(([id, value]) => [id, { ...blocks[id], ...value }]),
    ),
  }
}

// Tool output carries the committed revision; never apply textual diffs to a guessed base.
export function applyWritingFileUpdates(history: ConversationHistory): ConversationHistory {
  const revisions = new Map<string, { fileId: string; version: number }>()
  for (const message of history.messages) {
    if (message.role !== "tool") continue
    const parts = message.content.parts
    const text =
      typeof message.content.text === "string"
        ? message.content.text
        : Array.isArray(parts) && parts.every((part) => typeof part === "string")
          ? parts.join("")
          : ""
    let value
    try {
      value = JSON.parse(text)
    } catch {
      continue
    }
    const parsed = filePatchSchema.safeParse(value, { jitless: true })
    if (!parsed.success) continue
    const patch = parsed.data
    const updates = z
      .array(
        z.object({
          resource: z.object({
            type: z.string(),
            id: z.string(),
            revision_id: z.string().optional(),
          }),
        }),
      )
      .safeParse(message.metadata.resource_updates, { jitless: true })
    const fileId =
      patch.current_content_file_id ??
      (updates.success
        ? updates.data.find(
            (update) =>
              update.resource.type === "library_file" &&
              update.resource.id === patch.library_file_id,
          )?.resource.revision_id
        : undefined)
    if (!fileId) continue
    if ((revisions.get(patch.library_file_id)?.version ?? -1) <= patch.current_version_number)
      revisions.set(patch.library_file_id, { fileId, version: patch.current_version_number })
  }
  if (!revisions.size) return history
  return {
    ...history,
    messages: history.messages.map((message) => {
      const parsed = writingBlocksSchema.safeParse(message.metadata.writing_blocks, {
        jitless: true,
      })
      if (!parsed.success) return message
      const blocks = Object.fromEntries(
        Object.entries(parsed.data).map(([id, block]) => {
          const revision = block.library_file_id && revisions.get(block.library_file_id)
          const currentVersion =
            typeof block.current_version_number === "number" ? block.current_version_number : -1
          return [
            id,
            revision && revision.version >= currentVersion
              ? {
                  ...block,
                  current_content_file_id: revision.fileId,
                  current_version_number: revision.version,
                }
              : block,
          ]
        }),
      )
      return { ...message, metadata: { ...message.metadata, writing_blocks: blocks } }
    }),
  }
}
