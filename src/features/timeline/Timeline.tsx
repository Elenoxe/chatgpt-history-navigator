import { useTranslation } from 'react-i18next';

export default function Timeline() {
  const { t, i18n } = useTranslation();

  return (
    <aside
      className="tw:fixed tw:top-1/2 tw:right-4 tw:z-1000 tw:w-[220px] tw:max-w-[calc(100vw-32px)] tw:-translate-y-1/2 tw:rounded-xl tw:border tw:border-outline tw:bg-surface tw:p-4 tw:text-sm tw:text-foreground tw:shadow-panel"
      aria-labelledby="timeline-title"
      lang={i18n.language}
    >
      <h2 id="timeline-title" className="tw:mb-2 tw:font-bold">
        {t('timelineTitle')}
      </h2>
      <p className="tw:text-muted">{t('timelinePlaceholder')}</p>
    </aside>
  );
}
