import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
import App from './App';
import { i18n, initI18n } from '@/i18n';
import { getPageLanguage, observePage } from '@/platform/chatgpt/page';
import './style.css';

export default defineContentScript({
  matches: ['https://chatgpt.com/*'],
  cssInjectionMode: 'ui',

  async main(ctx) {
    await initI18n(getPageLanguage());
    if (ctx.isInvalid) return;

    const queryClient = new QueryClient();
    const stopObservingPage = observePage(ctx, (identityChanged) => {
      // Query's manual page updates also update its cancellation restore point.
      void queryClient.cancelQueries({ queryKey: ['timeline'] });
      if (identityChanged) queryClient.removeQueries({ queryKey: ['timeline'] });
    });
    ctx.onInvalidated(stopObservingPage);

    const ui = await createShadowRootUi(ctx, {
      name: 'chatgpt-timeline',
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
        stopObservingPage();
        root?.unmount();
        queryClient.clear();
      },
    });

    ui.mount();
  },
});
