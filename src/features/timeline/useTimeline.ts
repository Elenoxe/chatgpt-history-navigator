import { getConversationContextSnapshot, subscribeConversationContext, observeVisibleQuestions, scrollToQuestion } from "@/platform/chatgpt/page";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { getTimelineQueryOptions } from "./query";
import type { ConversationMessage } from '@/platform/chatgpt/conversation';

function messageText(message: ConversationMessage) {
  if (message.content.content_type !== 'text' && message.content.content_type !== 'multimodal_text') return '';
  return (Array.isArray(message.content.parts)
    ? message.content.parts.filter((part): part is string => typeof part === 'string').join('\n')
    : typeof message.content.text === 'string' ? message.content.text : '').trim();
}

export function useTimeline() {
  const snapshot = useSyncExternalStore(subscribeConversationContext, getConversationContextSnapshot);
  const [userId, conversationId] = JSON.parse(snapshot) as [
    string | null,
    string | null,
  ];
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
      console.error('[chatgpt-timeline] Failed to locate question:', error);
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
      const questions: { id: string; text: string; response: string }[] = [];
      let current: (typeof questions)[number] | undefined;
      for (const message of query.data?.messages ?? []) {
        if (message.role === 'user') {
          current = message.hidden ? undefined : { id: message.id, text: messageText(message), response: '' };
          if (current) questions.push(current);
        } else if (current && !message.hidden &&
            (message.recipient === null || message.recipient === 'all') &&
            (message.channel === null || message.channel === 'final')) {
          const text = messageText(message);
          if (text) current.response += (current.response ? '\n' : '') + text;
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
