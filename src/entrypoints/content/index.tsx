import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
import App from './App';
import { i18n, initI18n } from '@/i18n';
import { getPageLanguage, hideNativeTimeline, startConversationContextObserver } from '@/platform/chatgpt/page';
import { startCapturedHistorySync } from '@/features/timeline/query';
import './style.css';

export default defineContentScript({
  matches: ['https://chatgpt.com/*'],
  cssInjectionMode: 'ui',
  runAt: 'document_start',

  async main(ctx) {
    const queryClient = new QueryClient();
    const stopCapturedHistorySync = startCapturedHistorySync(queryClient);
    ctx.onInvalidated(() => {
      stopCapturedHistorySync();
      queryClient.clear();
    });
    if (document.readyState === 'loading') {
      await new Promise<void>((resolve) => {
        document.addEventListener('DOMContentLoaded', () => resolve(), { once: true, signal: ctx.signal });
        ctx.onInvalidated(resolve);
      });
    }
    if (ctx.isInvalid) return;
    const restoreNativeTimeline = hideNativeTimeline();
    ctx.onInvalidated(restoreNativeTimeline);
    await initI18n(getPageLanguage());
    if (ctx.isInvalid) return;

    const stopObservingConversationContext = startConversationContextObserver(ctx, (userChanged) => {
      // Query's manual page updates also update its cancellation restore point.
      void queryClient.cancelQueries({ queryKey: ['timeline'] });
      if (userChanged) queryClient.removeQueries({ queryKey: ['timeline'] });
    });
    ctx.onInvalidated(stopObservingConversationContext);

    const ui = await createShadowRootUi(ctx, {
      name: 'chatgpt-history-navigator',
      position: 'inline',
      anchor: 'body',
      onMount(container) {
        const app = document.createElement('div');
        container.append(app);
        const root = createRoot(app);
        root.render(
          <I18nextProvider i18n={i18n}>
            <QueryClientProvider client={queryClient}>
              <App />
            </QueryClientProvider>
          </I18nextProvider>,
        );
        return root;
      },
      onRemove(root) {
        restoreNativeTimeline();
        stopCapturedHistorySync();
        stopObservingConversationContext();
        root?.unmount();
        queryClient.clear();
      },
    });

    ui.mount();
  },
});
