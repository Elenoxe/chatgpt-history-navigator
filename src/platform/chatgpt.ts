import { z } from 'zod';

const languageSchema = z.string().trim().refine((value) => {
  try {
    new Intl.Locale(value);
    return true;
  } catch {
    return false;
  }
}, 'Invalid language tag');

const bootstrapSchema = z.object({ locale: languageSchema });

export function getPageLanguage(): string {
  const bootstrap = document.getElementById('client-bootstrap')?.textContent;
  if (bootstrap) {
    let data: unknown;
    try {
      data = JSON.parse(bootstrap);
    } catch {
      // Invalid bootstrap JSON uses the next language source below.
    }
    const result = bootstrapSchema.safeParse(data);
    if (result.success) return result.data.locale;
  }

  // Missing or invalid page data falls through in the requested priority order.
  const htmlLanguage = languageSchema.safeParse(document.documentElement.lang);
  if (htmlLanguage.success) return htmlLanguage.data;
  return languageSchema.parse(navigator.language);
}

export function observePageLanguage(onChange: (language: string) => void): () => void {
  let language: string | undefined;
  let bootstrap = document.getElementById('client-bootstrap');
  const update = () => {
    const next = getPageLanguage();
    if (next === language) return;
    language = next;
    onChange(next);
  };
  const observer = new MutationObserver((records) => {
    const current = document.getElementById('client-bootstrap');
    const changed = current !== bootstrap || records.some((record) =>
      (record.type === 'attributes' && record.target === document.documentElement) ||
      current?.contains(record.target),
    );
    bootstrap = current;
    if (changed) update();
  });
  // Observe replacement/insertion as well as edits to the bootstrap JSON.
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['lang'],
  });
  window.addEventListener('languagechange', update);
  update();

  return () => {
    observer.disconnect();
    window.removeEventListener('languagechange', update);
  };
}
