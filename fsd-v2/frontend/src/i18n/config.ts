// i18n bootstrap for the v2 SPA.
//
// Usage in any page or component:
//
//   import { useT } from '../hooks/useT';
//   const { t, i18n } = useT();
//   return <h1>{t('admin.title')}</h1>;
//
// To switch language: `i18n.changeLanguage('zh-Hant')`. The choice is
// persisted to localStorage under `fsd_lang` and picked up automatically
// on the next reload by the browser language detector.
//
// Locale JSONs are ported verbatim from v1's
// src/presentation/web/spa/src/locales/{en,zh-Hant,zh-Hans}.json so any
// existing page key continues to resolve.

import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

import en from './locales/en.json';
import zhHant from './locales/zh-Hant.json';
import zhHans from './locales/zh-Hans.json';

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      'zh-Hant': { translation: zhHant },
      'zh-Hans': { translation: zhHans },
    },
    fallbackLng: 'en',
    supportedLngs: ['en', 'zh-Hant', 'zh-Hans'],
    interpolation: { escapeValue: false }, // React already escapes
    detection: {
      // Read order: explicit user choice in localStorage > <html lang> >
      // navigator. Persist the resolved value back to localStorage so the
      // SPA opens in the same language next time.
      order: ['localStorage', 'htmlTag', 'navigator'],
      lookupLocalStorage: 'fsd_lang',
      caches: ['localStorage'],
    },
  });

export default i18n;
