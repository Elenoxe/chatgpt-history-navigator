import { getConversationContextSnapshot, subscribeConversationContext, observeVisibleQuestions, scrollToQuestion } from "@/platform/chatgpt/page";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { getTimelineQueryOptions } from "./query";
import type { ConversationMessage } from '@/platform/chatgpt/conversation';
import { messageText } from './previewContent';

export function useTimeline() {
  const snapshot = useSyncExternalStore(subscribeConversationContext, getConversationContextSnapshot);
  const [userId, conversationId] = JSON.parse(snapshot) as [
    string | null,
    string | null,
  ];
  const previewContext = useMemo(() => ({ userId, conversationId,
    projectId: location.pathname.match(/^\/g\/(g-p-[^/]+)/)?.[1],
    sharedId: location.pathname.match(/^\/share\/([^/]+)/)?.[1],
  }), [snapshot]);
  const navigation = useRef<AbortController | null>(null);
  const [pendingNavigation, setPendingNavigation] = useState<{ snapshot: string; id: string } | null>(null);
  const [navigationError, setNavigationError] = useState<{ snapshot: string; id: string } | null>(null);
  useEffect(() => () => navigation.current?.abort(), [snapshot]);
  const jumpToQuestion = async (id: string) => {
    navigation.current?.abort();
    const controller = new AbortController();
    navigation.current = controller;
    setPendingNavigation({ snapshot, id });
    setNavigationError(null);
    try {
      await scrollToQuestion(id, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) return;
      console.error('[chatgpt-history-navigator] Failed to locate question:', error);
      setNavigationError({ snapshot, id });
    } finally {
      if (navigation.current === controller) {
        navigation.current = null;
        setPendingNavigation(null);
      }
    }
  };
  const client = useQueryClient();
  const query = useQuery(
    getTimelineQueryOptions(client, userId, conversationId),
  );
  const questions = useMemo(
    () => {
      const questions: { id: string; text: string; message: ConversationMessage; responses: ConversationMessage[] }[] = [];
      let current: (typeof questions)[number] | undefined;
      for (const message of query.data?.messages ?? []) {
        if (message.role === 'user') {
          current = message.hidden ? undefined : { id: message.id, text: messageText(message), message, responses: [] };
          if (current) questions.push(current);
        } else if (current && message.role === 'assistant' && !message.hidden &&
            (message.recipient === null || message.recipient === 'all') &&
            (message.channel === null || message.channel === 'final')) {
          current.responses.push(message);
        }
      }
      return questions;
    },
    [query.data],
  );
  // A reply remains associated with its question even when the prompt is offscreen.
  const readingTargets = JSON.stringify(query.data?.messages.map(message => [message.id, message.role, message.hidden]) ?? []);
  const [reading, setReading] = useState<{ snapshot: string; ids: Set<string> }>({ snapshot: '', ids: new Set() });
  useEffect(() => {
    const targets = new Map<string, string>();
    let questionId: string | undefined;
    for (const [id, role, hidden] of JSON.parse(readingTargets) as [string, string, boolean][]) {
      if (role === 'user') questionId = hidden ? undefined : id;
      if (questionId && !hidden) targets.set(id, questionId);
    }
    setReading({ snapshot, ids: new Set() });
    if (!targets.size) return;
    return observeVisibleQuestions(targets, ids => setReading({ snapshot, ids }));
  }, [snapshot, readingTargets]);
  return {
    previewContext,
    conversationId,
    identityAvailable: userId !== null,
    questions,
    jumpToQuestion,
    pendingQuestionId: pendingNavigation?.snapshot === snapshot ? pendingNavigation.id : null,
    navigationErrorId: navigationError?.snapshot === snapshot ? navigationError.id : null,
    visibleQuestionIds: reading.snapshot === snapshot ? reading.ids : new Set<string>(),
    loadedQuestionCount: questions.length,
    totalQuestionCount: query.data?.isHistoryComplete ? questions.length : null,
    isLoading: query.isLoading,
    isSyncing: query.isFetching && query.data !== undefined,
    error: query.error,
    refresh: () => query.refetch({ cancelRefetch: false }),
  };
}
