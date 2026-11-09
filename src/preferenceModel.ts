export type Preferences = {
  collapseMobileHeader: boolean;
  interfaceLanguage: 'en' | 'ru' | 'es';
  topicLanguage: string;
  siteHeading: string;
  siteTitle: string;
  faviconEmoji: string;
  faviconImage: string;
  theme: 'blue' | 'aubergine' | 'orange' | 'rainbow';
  contentLanguages: string[];
  defaultSection: string;
  hideSingleRoot: boolean;
};
export const defaults: Preferences = { collapseMobileHeader: true, interfaceLanguage: 'en', contentLanguages: [], defaultSection: '', hideSingleRoot: true, topicLanguage: 'original', siteHeading: 'Remember Freely', siteTitle: 'Remember Freely', faviconEmoji: '', faviconImage: '', theme: 'blue' };
export function loadPreferences(saved: unknown): Preferences {
  const value = saved && typeof saved === 'object' ? saved as Partial<Preferences> : {};
  return {
    collapseMobileHeader: typeof value.collapseMobileHeader === 'boolean' ? value.collapseMobileHeader : defaults.collapseMobileHeader,
    interfaceLanguage: value.interfaceLanguage === 'ru' || value.interfaceLanguage === 'es' ? value.interfaceLanguage : 'en',
    topicLanguage: typeof value.topicLanguage === 'string' && /^(original|interface|[a-z]{2,3}(-[a-z0-9]{2,8})*)$/.test(value.topicLanguage) ? value.topicLanguage : defaults.topicLanguage,
    siteHeading: typeof value.siteHeading === 'string' ? value.siteHeading.slice(0, 120) : defaults.siteHeading,
    siteTitle: typeof value.siteTitle === 'string' ? value.siteTitle.slice(0, 120) : defaults.siteTitle,
    faviconEmoji: typeof value.faviconEmoji === 'string' ? [...value.faviconEmoji].slice(0, 8).join('') : '',
    faviconImage: validFaviconImage(value.faviconImage) ? value.faviconImage as string : '',
    theme: value.theme && ['blue', 'aubergine', 'orange', 'rainbow'].includes(value.theme) ? value.theme : 'blue',
    contentLanguages: Array.isArray(value.contentLanguages) && value.contentLanguages.every(item => typeof item === 'string' && /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/.test(item)) ? [...new Set(value.contentLanguages)].slice(0, 32) : [],
    defaultSection: typeof value.defaultSection === 'string' ? value.defaultSection : '',
    hideSingleRoot: typeof value.hideSingleRoot === 'boolean' ? value.hideSingleRoot : defaults.hideSingleRoot,
  };
}
export function contentWordings(text: string, translations: Record<string, string> | undefined, languages: string[]): { language?: string; text: string }[] {
  const available = Object.entries(translations ?? {}).filter(([, value]) => value.trim());
  if (!available.length) return [{ text }];
  const selected = languages.length ? languages.flatMap(language => translations?.[language] ? [{ language, text: translations[language] }] : []) : available.map(([language, text]) => ({ language, text }));
  return selected.length ? selected : [{ text: text || available[0]?.[1] || '' }];
}
export function libraryRoots<T extends { id: string; parent_id: string | null }>(nodes: T[], section: string, hideSingle: boolean): T[] {
  let roots = section && nodes.some(node => node.id === section && !node.parent_id) ? nodes.filter(node => node.id === section) : nodes.filter(node => !node.parent_id);
  if (hideSingle && roots.length === 1) {
    const children = nodes.filter(node => node.parent_id === roots[0].id);
    if (children.length) roots = children;
  }
  return roots;
}

export function topicLabel(node: { label: string; translations?: Record<string, string> }, language: string, interfaceLanguage: string): string {
  const selected = language === 'interface' ? interfaceLanguage : language;
  return selected === 'original' ? node.label : node.translations?.[selected] || node.label;
}
export function validFaviconImage(value: unknown): boolean {
  return typeof value === 'string' && value.length <= 90_000 && /^data:image\/(png|jpeg|webp|x-icon|vnd.microsoft.icon);base64,[A-Za-z0-9+/]+=*$/.test(value);
}
export function emojiFavicon(emoji: string): string {
  const escaped = emoji.replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[character]!));
  return 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><text y="50" x="4" font-size="52">${escaped}</text></svg>`);
}
