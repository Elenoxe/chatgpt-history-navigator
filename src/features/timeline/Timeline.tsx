import { useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { hideNativeTimeline } from '../../platform/chatgpt/page';
import { useTimeline } from './useTimeline';
import './timeline.css';

const previewComponents: Components = {
  a: ({ children }) => <span>{children}</span>,
  img: ({ alt }) => <span>{alt}</span>,
};
const previewPlugins = [remarkGfm];

export default function Timeline() {
  const { t, i18n } = useTranslation();
  const timeline = useTimeline();
  const isVisible = !!timeline.conversationId && timeline.questions.length > 0;
  useLayoutEffect(() => {
    if (isVisible) return hideNativeTimeline();
  }, [isVisible]);
  const trackRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const interactingWithTrack = useRef(false);
  const followedQuestion = useRef<string | null>(null);
  const [preview, setPreview] = useState<{ id: string; conversationId: string | null; anchor: HTMLElement } | null>(null);
  const question = preview?.conversationId === timeline.conversationId
    ? timeline.questions.find(question => question.id === preview?.id) : undefined;
  const showPreview = (id: string, element: HTMLElement) => {
    setPreview({ id, conversationId: timeline.conversationId, anchor: element });
  };

  useLayoutEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const current = track.querySelector<HTMLElement>('[aria-current="true"]');
    if (!current) return;
    const key = `${timeline.conversationId}:${current.dataset.questionId}`;
    if (followedQuestion.current === key) return;
    followedQuestion.current = key;
    if (interactingWithTrack.current) return;
    const bounds = track.getBoundingClientRect();
    const marker = current.getBoundingClientRect();
    if (marker.top < bounds.top) track.scrollTop += marker.top - bounds.top;
    else if (marker.bottom > bounds.bottom) track.scrollTop += marker.bottom - bounds.bottom;
  }, [timeline.visibleQuestionIds, timeline.conversationId]);

  useLayoutEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const updateEdges = () => {
      const remaining = Math.max(0, track.scrollHeight - track.clientHeight - track.scrollTop);
      track.style.setProperty('--timeline-scroll-top', `${Math.max(0, track.scrollTop)}px`);
      track.style.setProperty('--timeline-scroll-bottom', `${remaining}px`);
    };
    updateEdges();
    const observer = new ResizeObserver(updateEdges);
    observer.observe(track);
    // Observe content height too, including changes to themed marker spacing.
    for (const child of track.children) observer.observe(child);
    track.addEventListener('scroll', updateEdges, { passive: true });
    return () => {
      observer.disconnect();
      track.removeEventListener('scroll', updateEdges);
    };
  }, [timeline.conversationId, timeline.questions]);

  useLayoutEffect(() => {
    const card = previewRef.current;
    if (!card || !preview || !question) return;
    const updatePosition = () => {
      const rect = preview.anchor.getBoundingClientRect();
      card.style.setProperty('--preview-anchor-center', `${rect.top + rect.height / 2}px`);
      card.style.setProperty('--preview-height', `${card.getBoundingClientRect().height}px`);
    };
    updatePosition();
    const observer = new ResizeObserver(updatePosition);
    observer.observe(card);
    // A changed rail height moves every marker because the rail is centered.
    const rail = preview.anchor.closest('.timeline');
    if (rail) observer.observe(rail);
    window.addEventListener('resize', updatePosition);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updatePosition);
    };
  }, [preview, question]);

  if (!isVisible) return null;

  return <>
    <aside className="timeline" aria-label={t('timelineTitle')} lang={i18n.language}
      onPointerLeave={() => setPreview(null)}
      onKeyDown={event => { if (event.key === 'Escape') setPreview(null); }}>
      <div className="timeline-track" ref={trackRef} onScroll={() => setPreview(null)}
        onPointerEnter={() => { interactingWithTrack.current = true; }}
        onPointerLeave={() => { interactingWithTrack.current = false; }}
        onFocus={() => { interactingWithTrack.current = true; }}
        onBlur={event => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) interactingWithTrack.current = false;
        }}>
        {timeline.questions.map((item, index) => <button key={item.id} type="button" className="timeline-tick"
          data-question-id={item.id}
          data-preview={question?.id === item.id || undefined}
          aria-current={timeline.visibleQuestionIds.has(item.id) ? 'true' : undefined}
          aria-label={`${index + 1}. ${item.text || t('timelineNonText')}`}
          aria-describedby={question?.id === item.id ? 'timeline-preview' : undefined}
          onPointerEnter={event => showPreview(item.id, event.currentTarget)}
          onFocus={event => showPreview(item.id, event.currentTarget)}
          onBlur={() => setPreview(null)}
          onClick={event => {
            showPreview(item.id, event.currentTarget);
            void timeline.jumpToQuestion(item.id);
          }}>
          <span aria-hidden="true" />
        </button>)}
      </div>
    </aside>
    {question && preview && <div id="timeline-preview" role="tooltip" className="timeline-preview"
      lang={i18n.language} ref={previewRef}>
      <div className="timeline-preview-title">
        <Markdown remarkPlugins={previewPlugins} components={previewComponents} skipHtml>
          {question.text || t('timelineNonText')}
        </Markdown>
      </div>
      {timeline.navigationErrorId === question.id && <div role="alert" className="timeline-preview-body">
        {t('timelineNavigationFailed')}
      </div>}
      {question.response && <div className="timeline-preview-body">
        <Markdown remarkPlugins={previewPlugins} components={previewComponents} skipHtml>
          {question.response}
        </Markdown>
      </div>}
    </div>}
  </>;
}
