import { createContext, useContext, useState, type ReactNode } from 'react';

type Preferences = { collapseMobileHeader: boolean };
const defaults: Preferences = { collapseMobileHeader: true };
const storageKey = 'practice-display-preferences-v1';
const PreferencesContext = createContext<{ preferences: Preferences; update: (key: keyof Preferences, value: boolean) => void }>({ preferences: defaults, update: () => {} });

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const [preferences, setPreferences] = useState<Preferences>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || '{}');
      return Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => [key, typeof saved?.[key] === 'boolean' ? saved[key] : fallback])) as Preferences;
    } catch { return defaults; }
  });
  function update(key: keyof Preferences, value: boolean) {
    setPreferences(current => {
      const next = { ...current, [key]: value };
      try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* Preferences remain available for this session. */ }
      return next;
    });
  }
  return <PreferencesContext.Provider value={{ preferences, update }}>{children}</PreferencesContext.Provider>;
}
export const usePreferences = () => useContext(PreferencesContext);

export function QuestionText({ text }: { text: string; answer?: boolean }) {
  return <span style={{ whiteSpace: 'pre-wrap' }}>{text}</span>;
}

export function TrainingFrame({ children }: { children: ReactNode }) {
  const { preferences } = usePreferences();
  const [override, setOverride] = useState<boolean | null>(null);
  const collapsed = override ?? preferences.collapseMobileHeader;
  return <div className={`training-page ${collapsed ? 'mobile-header-collapsed' : 'mobile-header-expanded'}`}>
    <button type="button" className="mobile-header-toggle" aria-expanded={!collapsed} aria-label={collapsed ? 'Expand the top panel' : 'Collapse the top panel'} onClick={() => setOverride(!collapsed)}>
      <svg viewBox="0 0 20 20" aria-hidden="true"><path d={collapsed ? 'm5 4 5 4 5-4M5 11l5 4 5-4' : 'm5 9 5-4 5 4m-10 7 5-4 5 4'} /></svg>
      {collapsed ? 'Expand' : 'Collapse'}
    </button>
    {children}
  </div>;
}
