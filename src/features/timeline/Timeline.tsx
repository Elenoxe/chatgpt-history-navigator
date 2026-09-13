import { useTranslation } from 'react-i18next';
import { useTimeline } from './useTimeline';

export default function Timeline() {
  const { t, i18n } = useTranslation();
  const timeline = useTimeline();

  return (
    <aside
      className="tw:fixed tw:top-1/2 tw:right-4 tw:z-1000 tw:w-[220px] tw:max-w-[calc(100vw-32px)] tw:-translate-y-1/2 tw:rounded-xl tw:border tw:border-outline tw:bg-surface tw:p-4 tw:text-sm tw:text-foreground tw:shadow-panel"
      aria-labelledby="timeline-title"
      lang={i18n.language}
    >
      <h2 id="timeline-title" className="tw:mb-2 tw:font-bold">
        {t('timelineTitle')}
      </h2>
      {!timeline.conversationId ? <p className="tw:text-muted">{t('timelineNoConversation')}</p>
        : !timeline.identityAvailable ? <p role="alert">{t('timelineIdentityUnavailable')}</p>
          : <>
            <div className="tw:mb-3 tw:flex tw:items-center tw:justify-between tw:gap-2">
              <p role="status" className="tw:text-muted">
                {timeline.isLoading ? t('timelineLoading')
                  : timeline.totalCount === null ? t('timelineLoaded', { count: timeline.loadedCount })
                    : t('timelineTotal', { count: timeline.totalCount })}
                {timeline.isSyncing && <span className="tw:block">{t('timelineSyncing')}</span>}
              </p>
              <button type="button" disabled={timeline.isLoading || timeline.isSyncing}
                onClick={() => void timeline.refresh()}
                className="tw:rounded tw:border tw:border-outline tw:px-2 tw:py-1 tw:disabled:opacity-50">
                {t('timelineRefresh')}
              </button>
            </div>
            {timeline.error && <p role="alert" className="tw:mb-3 tw:text-muted">{t('timelineError')}</p>}
            <ol className="tw:max-h-[60vh] tw:space-y-2 tw:overflow-y-auto">
              {timeline.questions.map((question, index) => <li key={question.id}
                className="tw:rounded tw:border tw:border-outline tw:p-2">
                <span className="tw:mr-2 tw:text-muted">{index + 1}.</span>
                <span className="tw:whitespace-pre-wrap tw:break-words">
                  {question.text ? question.text.slice(0, 160) + (question.text.length > 160 ? '…' : '') : t('timelineNonText')}
                </span>
              </li>)}
            </ol>
          </>}
    </aside>
  );
}
