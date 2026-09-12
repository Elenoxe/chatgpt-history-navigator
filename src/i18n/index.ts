import { observePageLanguage } from "@/platform/chatgpt";
import { createInstance } from "i18next";
import { useEffect } from "react";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.json";
import zhCN from "./locales/zh-CN.json";

export const i18n = createInstance();

function getSupportedLanguage(pageLanguage: string) {
  const language = new Intl.Locale(pageLanguage).language;
  // Chinese variants use Simplified Chinese; other languages use English.
  return language === "zh" ? "zh-CN" : "en";
}

export async function syncI18nLanguage(pageLanguage: string) {
  const language = getSupportedLanguage(pageLanguage);
  if (i18n.language !== language) await i18n.changeLanguage(language);
}

export function initI18n(pageLanguage: string) {
  return i18n.use(initReactI18next).init({
    lng: getSupportedLanguage(pageLanguage),
    supportedLngs: ["en", "zh-CN"],
    load: "currentOnly",
    fallbackLng: false,
    resources: {
      en: { translation: en },
      "zh-CN": { translation: zhCN },
    },
    interpolation: { escapeValue: false }, // React escapes rendered text.
  });
}
export function usePageLanguage() {
  useEffect(
    () =>
      observePageLanguage((language) => {
        void syncI18nLanguage(language).catch((error) => {
          console.error(
            "[chatgpt-timeline] Failed to sync page language:",
            error,
          );
        });
      }),
    [],
  );
}
