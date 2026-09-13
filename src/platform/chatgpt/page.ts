import { z } from 'zod';
import type { ContentScriptContext } from 'wxt/utils/content-script-context';

const pageChangeEvent = 'chatgpt-timeline:pagechange';
const identitySchema = z.object({ user: z.object({ id: z.string().min(1) }) });
let identityText: string | null | undefined;
let userId: string | null = null;

export function getPageSnapshot(): string {
  const text = document.getElementById('client-bootstrap')?.textContent ?? null;
  if (text !== identityText) {
    identityText = text;
    userId = null;
    if (text) {
      try {
        const parsed = identitySchema.safeParse(JSON.parse(text), { jitless: true });
        if (parsed.success) userId = parsed.data.user.id;
      } catch { /* An unreadable identity must not reuse another user's cache. */ }
    }
  }
  const match = location.pathname.match(/^(?:\/g\/[^/]+)?\/c\/([^/]+)\/?$/);
  const id = z.uuid().safeParse(match?.[1]);
  return JSON.stringify([userId, id.success ? id.data : null]);
}

export function subscribePage(onChange: () => void): () => void {
  window.addEventListener(pageChangeEvent, onChange);
  return () => window.removeEventListener(pageChangeEvent, onChange);
}

export function observePage(
  ctx: ContentScriptContext,
  beforeChange: (identityChanged: boolean) => void,
): () => void {
  let snapshot = getPageSnapshot();
  const update = () => {
    const next = getPageSnapshot();
    if (snapshot === next) return;
    beforeChange(JSON.parse(snapshot)[0] !== JSON.parse(next)[0]);
    snapshot = next;
    window.dispatchEvent(new Event(pageChangeEvent));
  };
  // WXT's Navigation API event fires before history.pushState commits the URL.
  ctx.addEventListener(window, 'wxt:locationchange', () => {
    queueMicrotask(() => { if (ctx.isValid) update(); });
  });
  let bootstrap = document.getElementById('client-bootstrap');
  const observer = new MutationObserver((records) => {
    const current = document.getElementById('client-bootstrap');
    if (current !== bootstrap || records.some((record) => current?.contains(record.target))) update();
    bootstrap = current;
  });
  observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
  return () => observer.disconnect();
}

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
