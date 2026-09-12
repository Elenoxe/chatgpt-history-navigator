import { createInstance } from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';
import zhCN from './locales/zh-CN.json';

export const i18n = createInstance();

export function initI18n(pageLanguage: string) {
  const language = new Intl.Locale(pageLanguage).language;

  return i18n.use(initReactI18next).init({
    // Chinese variants use Simplified Chinese; other languages use English.
    lng: language === 'zh' ? 'zh-CN' : 'en',
    supportedLngs: ['en', 'zh-CN'],
    load: 'currentOnly',
    fallbackLng: false,
    resources: {
      en: { translation: en },
      'zh-CN': { translation: zhCN },
    },
    interpolation: { escapeValue: false }, // React escapes rendered text.
  });
}
