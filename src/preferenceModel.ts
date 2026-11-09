export type Preferences = {
  collapseMobileHeader: boolean;
  interfaceLanguage: 'en' | 'ru';
  contentLanguages: string[];
  defaultSection: string;
  hideSingleRoot: boolean;
};
export const defaults: Preferences = { collapseMobileHeader: true, interfaceLanguage: 'en', contentLanguages: [], defaultSection: '', hideSingleRoot: true };
export function loadPreferences(saved: unknown): Preferences {
  const value = saved && typeof saved === 'object' ? saved as Partial<Preferences> : {};
  return {
    collapseMobileHeader: typeof value.collapseMobileHeader === 'boolean' ? value.collapseMobileHeader : defaults.collapseMobileHeader,
    interfaceLanguage: value.interfaceLanguage === 'ru' ? 'ru' : 'en',
    contentLanguages: Array.isArray(value.contentLanguages) && value.contentLanguages.every(item => typeof item === 'string' && /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/.test(item)) ? [...new Set(value.contentLanguages)].slice(0, 32) : [],
    defaultSection: typeof value.defaultSection === 'string' ? value.defaultSection : '',
    hideSingleRoot: typeof value.hideSingleRoot === 'boolean' ? value.hideSingleRoot : defaults.hideSingleRoot,
  };
}
export function contentWordings(text: string, translations: Record<string, string> | undefined, languages: string[]): { language?: string; text: string }[] {
  const available = Object.entries(translations ?? {}).filter(([, value]) => value.trim());
  if (!available.length) return [{ text }];
  const selected = languages.length ? languages.flatMap(language => translations?.[language] ? [{ language, text: translations[language] }] : []) : available.map(([language, text]) => ({ language, text }));
  return selected.length ? selected : [{ text }];
}
export function libraryRoots<T extends { id: string; parent_id: string | null }>(nodes: T[], section: string, hideSingle: boolean): T[] {
  let roots = section && nodes.some(node => node.id === section && !node.parent_id) ? nodes.filter(node => node.id === section) : nodes.filter(node => !node.parent_id);
  if (hideSingle && roots.length === 1) {
    const children = nodes.filter(node => node.parent_id === roots[0].id);
    if (children.length) roots = children;
  }
  return roots;
}
