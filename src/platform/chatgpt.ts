export function getPageLanguage(): string {
  return document.documentElement.lang.trim() || navigator.language;
}
