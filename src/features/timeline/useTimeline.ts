import {
  getConversationContextSnapshot,
  subscribeConversationContext,
  observeVisibleQuestions,
  scrollToQuestion,
} from "@/platform/chatgpt/page"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { getTimelineQueryOptions } from "./query"
import type { ConversationMessage } from "@/platform/chatgpt/conversation"
import { messageText } from "./previewContent"
import { toast } from "sonner"
import { useTranslation } from "react-i18next"

const loadErrorToast = "chatgpt-history-navigator:load-error"
const navigationErrorToast = "chatgpt-history-navigator:navigation-error"

export function useTimeline() {
  const { t } = useTranslation()
  const snapshot = useSyncExternalStore(
    subscribeConversationContext,
    getConversationContextSnapshot,
  )
  const [userId, conversationId] = JSON.parse(snapshot) as [string | null, string | null]
  const previewContext = useMemo(
    () => ({
      userId,
      conversationId,
      projectId: location.pathname.match(/^\/g\/(g-p-[^/]+)/)?.[1],
      sharedId: location.pathname.match(/^\/share\/([^/]+)/)?.[1],
    }),
    [snapshot],
  )
  const navigation = useRef<AbortController | null>(null)
  const [pendingNavigation, setPendingNavigation] = useState<{
    snapshot: string
    id: string
  } | null>(null)
  useEffect(
    () => () => {
      navigation.current?.abort()
      toast.dismiss(loadErrorToast)
      toast.dismiss(navigationErrorToast)
    },
    [snapshot],
  )
  const jumpToQuestion = async (id: string) => {
    navigation.current?.abort()
    const controller = new AbortController()
    navigation.current = controller
    toast.dismiss(navigationErrorToast)
    setPendingNavigation({ snapshot, id })
    try {
      await scrollToQuestion(
        id,
        questions.map((question) => question.id),
        controller.signal,
      )
    } catch (error) {
      if (controller.signal.aborted || getConversationContextSnapshot() !== snapshot) return
      console.error("[chatgpt-history-navigator] Failed to locate question:", {
        conversationId,
        messageId: id,
        name: error instanceof Error ? error.name : "UnknownError",
        message: error instanceof Error ? error.message : "Unknown navigation error",
      })
      toast.error(t("timeline.errors.navigationFailed"), { id: navigationErrorToast })
    } finally {
      if (navigation.current === controller) {
        navigation.current = null
        setPendingNavigation(null)
      }
    }
  }
  const client = useQueryClient()
  const query = useQuery(getTimelineQueryOptions(client, userId, conversationId))
  const reportedLoadError = useRef<string | null>(null)
  useEffect(() => {
    if (getConversationContextSnapshot() !== snapshot || query.isFetching) return
    if (!query.isError) {
      if (query.isSuccess) toast.dismiss(loadErrorToast)
      return
    }
    const event = `${snapshot}:${query.errorUpdatedAt}`
    if (reportedLoadError.current === event) return
    reportedLoadError.current = event
    console.error("[chatgpt-history-navigator] History loading failed:", {
      conversationId,
      name: query.error.name,
      message: query.error.message,
    })
    toast.error(t("timeline.errors.historyFailed"), { id: loadErrorToast })
  }, [
    snapshot,
    conversationId,
    query.isFetching,
    query.isError,
    query.isSuccess,
    query.error,
    query.errorUpdatedAt,
    t,
  ])
  const questions = useMemo(() => {
    const questions: {
      id: string
      text: string
      message: ConversationMessage
      responses: ConversationMessage[]
    }[] = []
    let current: (typeof questions)[number] | undefined
    for (const message of query.data?.messages ?? []) {
      if (message.role === "user") {
        current = message.hidden
          ? undefined
          : { id: message.id, text: messageText(message), message, responses: [] }
        if (current) questions.push(current)
      } else if (
        current &&
        message.role === "assistant" &&
        !message.hidden &&
        (message.recipient === null || message.recipient === "all") &&
        (message.channel === null || message.channel === "final")
      ) {
        current.responses.push(message)
      }
    }
    return questions
  }, [query.data])
  // A reply remains associated with its question even when the prompt is offscreen.
  const readingTargets = JSON.stringify(
    query.data?.messages.map((message) => [message.id, message.role, message.hidden]) ?? [],
  )
  const [reading, setReading] = useState<{ snapshot: string; ids: Set<string> }>({
    snapshot: "",
    ids: new Set(),
  })
  useEffect(() => {
    const targets = new Map<string, string>()
    let questionId: string | undefined
    for (const [id, role, hidden] of JSON.parse(readingTargets) as [string, string, boolean][]) {
      if (role === "user") questionId = hidden ? undefined : id
      if (questionId && !hidden) targets.set(id, questionId)
    }
    setReading({ snapshot, ids: new Set() })
    if (!targets.size) return
    return observeVisibleQuestions(targets, (ids) => setReading({ snapshot, ids }))
  }, [snapshot, readingTargets])
  return {
    previewContext,
    conversationId,
    identityAvailable: userId !== null,
    questions,
    jumpToQuestion,
    pendingQuestionId: pendingNavigation?.snapshot === snapshot ? pendingNavigation.id : null,
    visibleQuestionIds: reading.snapshot === snapshot ? reading.ids : new Set<string>(),
    loadedQuestionCount: questions.length,
    totalQuestionCount: query.data?.isHistoryComplete ? questions.length : null,
    isLoading: query.isLoading,
    isSyncing: query.isFetching && query.data !== undefined,
    error: query.error,
    refresh: () => query.refetch({ cancelRefetch: false }),
  }
}
