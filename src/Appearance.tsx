import { useRef, useState } from 'react';
import { usePreferences, useT } from './Preferences';
import { defaults, validFaviconImage } from './preferenceModel';

export function AppearancePreferences() {
  const t = useT();
  const { preferences, update } = usePreferences();
  const [error, setError] = useState('');
  const upload = useRef<HTMLInputElement>(null);
  async function chooseIcon(file: File | undefined) {
    setError('');
    if (!file) return;
    if (file.size > 65536) { setError('Use an icon up to 64 KiB.'); return; }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const signature = Array.from(bytes.slice(0, 12));
    const mime = signature.slice(0, 8).join(',') === '137,80,78,71,13,10,26,10' ? 'image/png'
      : signature[0] === 255 && signature[1] === 216 && signature[2] === 255 ? 'image/jpeg'
      : signature.slice(0, 4).join(',') === '0,0,1,0' ? 'image/x-icon'
      : String.fromCharCode(...bytes.slice(0,4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8,12)) === 'WEBP' ? 'image/webp' : '';
    if (!mime) { setError('Choose a PNG, JPEG, WebP or ICO image.'); return; }
    const image = `data:${mime};base64,${btoa(String.fromCharCode(...bytes))}`;
    if (validFaviconImage(image)) { update('faviconImage', image); update('faviconEmoji', ''); }
  }
  return <details className="appearance-preferences"><summary>{t('Appearance')}</summary><div className="appearance-fields">
    <label>{t('Site heading')}<input maxLength={120} value={preferences.siteHeading} onChange={e => update('siteHeading', e.target.value)} /></label>
    <label>{t('Browser tab title')}<input maxLength={120} value={preferences.siteTitle} onChange={e => update('siteTitle', e.target.value)} /></label>
    <label>{t('Color theme')}<select value={preferences.theme} onChange={e => update('theme', e.target.value as typeof preferences.theme)}>
      <option value="blue">{t('Blue')}</option><option value="aubergine">{t('Aubergine')}</option><option value="orange">{t('Orange')}</option><option value="rainbow">{t('Rainbow')}</option>
    </select></label>
    <label>{t('Favicon emoji')}<input value={preferences.faviconEmoji} maxLength={16} placeholder="📘" onChange={e => { update('faviconEmoji', [...e.target.value].slice(0,8).join('')); update('faviconImage', ''); }} /></label>
    <label>{t('Favicon image')}<input ref={upload} type="file" accept="image/png,image/jpeg,image/webp,image/x-icon,.ico" onChange={e => { void chooseIcon(e.target.files?.[0]).catch(() => setError('Could not read the icon.')); }} /></label>
    <small>{t('PNG, JPEG, WebP or ICO, up to 64 KiB. Stored in this browser only.')}</small>
    {error && <p role="alert">{t(error)}</p>}
    <button type="button" onClick={() => { update('siteHeading', defaults.siteHeading); update('siteTitle', defaults.siteTitle); update('theme', defaults.theme); update('faviconEmoji', ''); update('faviconImage', ''); setError(''); if (upload.current) upload.current.value = ''; }}>{t('Reset appearance')}</button>
    <small>{t('Appearance changes apply only in this browser.')}</small>
  </div></details>;
}
