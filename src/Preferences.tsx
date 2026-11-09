import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';

import { defaults, loadPreferences, contentWordings, emojiFavicon, type Preferences } from './preferenceModel';
import { spanish } from './spanish';
import { russian } from './translations';
const storageKey = 'practice-display-preferences-v1';
const PreferencesContext = createContext<{ preferences: Preferences; update: <K extends keyof Preferences>(key: K, value: Preferences[K]) => void }>({ preferences: defaults, update: () => {} });

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const [preferences, setPreferences] = useState<Preferences>(() => {
    try { return loadPreferences(JSON.parse(localStorage.getItem(storageKey) || '{}')); }
    catch { return defaults; }
  });
  useEffect(() => { document.documentElement.lang = preferences.interfaceLanguage; }, [preferences.interfaceLanguage]);
  useEffect(() => {
    document.documentElement.dataset.theme = preferences.theme;
    document.title = preferences.siteTitle.trim() || defaults.siteTitle;
    let icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!icon) { icon = document.createElement('link'); icon.rel = 'icon'; document.head.append(icon); }
    icon.href = preferences.faviconImage || (preferences.faviconEmoji ? emojiFavicon(preferences.faviconEmoji) : '/favicon.svg');
    icon.removeAttribute('type');
  }, [preferences.theme, preferences.siteTitle, preferences.faviconEmoji, preferences.faviconImage]);
  function update<K extends keyof Preferences>(key: K, value: Preferences[K]) {
    setPreferences(current => {
      const next = { ...current, [key]: value };
      try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* Preferences remain available for this session. */ }
      return next;
    });
  }
  return <PreferencesContext.Provider value={{ preferences, update }}>{children}</PreferencesContext.Provider>;
}
export const usePreferences = () => useContext(PreferencesContext);
export function useT() {
  const { preferences } = usePreferences();
  return useCallback((text: string, values: Record<string, string | number> = {}) => {
    const catalog = preferences.interfaceLanguage === 'ru' ? russian : preferences.interfaceLanguage === 'es' ? spanish : {};
    const wording = catalog[text] ?? text;
    return wording.replace(/\{(\w+)\}/g, (match, key: string) => String(values[key] ?? match));
  }, [preferences.interfaceLanguage]);
}
export function QuestionText({ text, translations }: { text: string; answer?: boolean; translations?: Record<string, string> }) {
  const { preferences } = usePreferences();
  const wordings = contentWordings(text, translations, preferences.contentLanguages);
  return <span className="question-wordings">{wordings.map((wording, index) => <span className="question-wording" lang={wording.language} key={wording.language ?? index}>{wording.text}</span>)}</span>;
}

export function TrainingFrame({ children }: { children: ReactNode }) {
  const t = useT();
  const { preferences } = usePreferences();
  const [override, setOverride] = useState<boolean | null>(null);
  const collapsed = override ?? preferences.collapseMobileHeader;
  return <div className={`training-page ${collapsed ? 'mobile-header-collapsed' : 'mobile-header-expanded'}`}>
    <button type="button" className="mobile-header-toggle" aria-expanded={!collapsed} aria-label={collapsed ? t("Expand the top panel") : t("Collapse the top panel")} onClick={() => setOverride(!collapsed)}>
      <svg viewBox="0 0 20 20" aria-hidden="true"><path d={collapsed ? 'm5 4 5 4 5-4M5 11l5 4 5-4' : 'm5 9 5-4 5 4m-10 7 5-4 5 4'} /></svg>
      {collapsed ? t("Expand") : t("Collapse")}
    </button>
    {children}
  </div>;
}
