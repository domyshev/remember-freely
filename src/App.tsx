import { useT } from './Preferences';
import { useCallback, useEffect, useMemo, useLayoutEffect, useRef, useState, useTransition } from 'react';
import { createPortal } from 'react-dom';
import { AppearancePreferences } from './Appearance';
import { libraryRoots, contentWordings, topicLabel } from './preferenceModel';
import { AccountImports } from './AccountImports';
import { LinearStatistics, ReleaseDetails } from './LinearStatistics';
import { LibrarySearch, SearchText, defaultSearchScope, type SearchScope } from './LibrarySearch';
import { readRoute, useTrainingNavigation } from './navigation';
import { topicReviewState, topicErrorLabel, topicContinuation, topicReturnState, topicBranchProgress } from './topicActions';
import { PreferencesProvider, usePreferences, QuestionText, TrainingFrame } from './Preferences';

type Answer = { translations?: Record<string, string>; letter: string; text: string; correct?: boolean };
type AuthUser = { id: string; email: string };
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json', ...init.headers } : init?.headers,
    credentials: 'same-origin',
    cache: 'no-store',
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(payload.error ?? `HTTP ${response.status}`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function HelpContent({ text }: { text: string }) {
  const blocks = text.split(/\n\s*\n/).map(block => block.trim()).filter(Boolean);

  return (
    <div className="help-content">
      {blocks.map((block, index) => {
        return <p className="help-paragraph" key={index}>{block}</p>;
      })}
    </div>
  );
}

function Modal({
  title,
  eyebrow,
  className = '',
  onClose,
  children,
}: {
  title: string;
  eyebrow?: string;
  className?: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const t = useT();
  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  return (
    <div className="modal-overlay" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className={`modal-card ${className}`} role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-header">
          <div>
            {eyebrow && <p>{eyebrow}</p>}
            <h2>{title}</h2>
          </div>
          <button type="button" className="modal-close-icon" aria-label={t("Close")} onClick={onClose}>×</button>
        </header>
        <div className="modal-body">{children}</div>
        <footer className="modal-footer">
          <button type="button" className="secondary" onClick={onClose}>{t("Close")}</button>
        </footer>
      </section>
    </div>
  );
}

function AccountMenu({ user, onLogout }: { user: AuthUser; onLogout: () => Promise<void> }) {
  const t = useT();
  const { preferences, update } = usePreferences();
  const [settingsLibrary, setSettingsLibrary] = useState<LibraryData>({ nodes: [], questions: [] });
  useEffect(() => {
    let active = true;
    const load = () => { void api<LibraryData>('/api/library').then(data => { if (active) setSettingsLibrary(data); }).catch(() => {}); };
    load(); window.addEventListener('library-imported', load);
    return () => { active = false; window.removeEventListener('library-imported', load); };
  }, []);
  const languageCodes = [...new Set([...preferences.contentLanguages, ...settingsLibrary.questions.flatMap(question => [...(question.languages ?? []), ...Object.keys(question.translations ?? {})])])].sort();
  const languageName = (code: string) => { try { return new Intl.DisplayNames([preferences.interfaceLanguage], { type: 'language' }).of(code) ?? code; } catch { return code; } };
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    function outside(event: PointerEvent) {
      if (event.target instanceof Node && !menu.current?.contains(event.target)) setOpen(false);
    }
    function escape(event: KeyboardEvent) {
      if (event.key === 'Escape') { setOpen(false); trigger.current?.focus(); }
    }
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [open]);
  async function signOut() {
    if (busy) return;
    setBusy(true);
    try { await onLogout(); } finally { setBusy(false); setOpen(false); }
  }
  return <><div className="account-menu-shell" ref={menu}>
    <ReleaseDetails />
    <button ref={trigger} type="button" className="account-menu-trigger" aria-label={t("User menu")} aria-expanded={open} aria-controls="account-menu" onClick={() => setOpen(!open)}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
    </button>
    {open && <section id="account-menu" className="account-menu-panel" aria-label={t("Account")}><p>{user.email}</p><hr /><AppearancePreferences /><hr /><button type="button" onClick={() => { setOpen(false); if (readRoute().screen !== 'statistics') { window.history.pushState(null, '', '?screen=statistics'); window.dispatchEvent(new PopStateEvent('popstate')); } }}>{t("Statistics")}</button><button type="button" onClick={() => { setOpen(false); setSettingsOpen(true); }}>{t("Settings")}</button><button type="button" disabled={busy} onClick={signOut}>{busy ? t("Signing out…") : t("Sign out")}</button></section>}
  </div>{settingsOpen && <Modal eyebrow={t("Preferences")} title={t("Settings")} className="settings-modal" onClose={() => setSettingsOpen(false)}>
    <div className="settings-options">
      <label><span><strong>{t("Interface language")}</strong></span><select value={preferences.interfaceLanguage} onChange={e => update('interfaceLanguage', e.target.value === 'ru' || e.target.value === 'es' ? e.target.value : 'en')}><option value="en">English</option><option value="ru">Русский</option><option value="es">Español</option></select></label>
      <label><span><strong>{t('Topic and subtopic language')}</strong><small>{t('Missing translations use the original title.')}</small></span><select value={preferences.topicLanguage} onChange={e => update('topicLanguage', e.target.value)}><option value="original">{t('Original titles')}</option><option value="interface">{t('Match interface language')}</option>{[...new Set(['en','ru','es', ...settingsLibrary.nodes.flatMap(node => Object.keys(node.translations ?? {})), ...(!['original','interface'].includes(preferences.topicLanguage) ? [preferences.topicLanguage] : [])])].map(code => <option key={code} value={code}>{languageName(code)}</option>)}</select></label>
      <label><span><strong>{t("Default section")}</strong><small>{t("Open this section on the learning dashboard")}</small></span><select value={settingsLibrary.nodes.some(node => node.id === preferences.defaultSection && !node.parent_id) ? preferences.defaultSection : ''} onChange={e => { update('defaultSection', e.target.value); window.dispatchEvent(new Event('default-section-changed')); }}><option value="">{t("All sections")}</option>{settingsLibrary.nodes.filter(node => !node.parent_id).map(node => <option value={node.id} key={node.id}>{topicLabel(node, preferences.topicLanguage, preferences.interfaceLanguage)}</option>)}</select></label>
      <label><span><strong>{t("Hide a single root section")}</strong><small>{t("Show its topics directly when only one section is visible")}</small></span><input type="checkbox" role="switch" checked={preferences.hideSingleRoot} onChange={e => update('hideSingleRoot', e.target.checked)} /></label>
      <fieldset className="content-language-settings"><legend>{t('Question and answer languages')}</legend><p>{t('Select multiple languages, or show all available translations. Missing translations use the original text.')}</p>
        <label><input type="checkbox" checked={!preferences.contentLanguages.length} onChange={() => update('contentLanguages', [])}/>{t('All available languages')}</label>
        {languageCodes.map(code => <label key={code}><input type="checkbox" checked={preferences.contentLanguages.includes(code)} onChange={e => update('contentLanguages', e.target.checked ? [...preferences.contentLanguages, code] : preferences.contentLanguages.filter(item => item !== code))}/>{languageName(code)}</label>)}
      </fieldset>
      {!languageCodes.length && <p className="settings-note">{t("This library has no labeled translations yet. Original question and answer text is always available.")}</p>}
      <label><span><strong>{t("Collapse the top panel")}</strong><small>{t("By default when opening a question on mobile")}</small></span><input type="checkbox" role="switch" checked={preferences.collapseMobileHeader} onChange={e => update('collapseMobileHeader', e.target.checked)} /></label>
    </div><p className="settings-note">{t("Display settings are saved in this browser.")}</p><AccountImports />
  </Modal>}</>;
}

function LoginScreen({ onAuthenticated }: { onAuthenticated: (user: AuthUser) => void }) {
  const t = useT();
  const { preferences } = usePreferences();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function requestCode(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/api/auth/request-code', { method: 'POST', body: JSON.stringify({ email }) });
      setStep('code');
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Could not send the code');
    } finally {
      setBusy(false);
    }
  }

  async function verifyCode(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const user = await api<AuthUser>('/api/auth/verify-code', { method: 'POST', body: JSON.stringify({ email, code }) });
      onAuthenticated(user);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Could not sign in');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-page">
      <section className="auth-card">
        <p className="eyebrow">{preferences.siteHeading.trim() || "Remember Freely"}</p>
        <h1>{step === 'email' ? t("Sign in or create an account") : t("Enter the code from your email")}</h1>
        <p>{step === 'email' ? t("No password needed. We will email you a one-time code.") : t('We sent a six-digit code to {email}', {email})}</p>
        <form onSubmit={step === 'email' ? requestCode : verifyCode}>
          {step === 'email' ? (
            <label>{t("Email")}<input type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" /></label>
          ) : (
            <label>{t("Code")}<input className="code-input" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))} placeholder="000000" autoFocus /></label>
          )}
          {error && <p className="auth-error" role="alert">{t(error)}</p>}
          <button className="primary" disabled={busy}>{busy ? t("Please wait…") : step === 'email' ? t("Get code") : t("Sign in")}</button>
          {step === 'code' && <button type="button" className="auth-back" onClick={() => { setStep('email'); setCode(''); setError(''); }}>{t("← Change email")}</button>}
        </form>
      </section>
    </main>
  );
}

type LibraryQuestion = { languages?: string[]; translations?: Record<string, string>; canonical_id: string; question: string; question_title?: string; topic_ids: string[]; verified: boolean };
type TopicNode = { translations?: Record<string,string>; id: string; label: string; parent_id: string | null };
type LibraryData = { nodes: TopicNode[]; questions: LibraryQuestion[] };

type TopicRun = { review_pending?: number; inherited?: number; kind: 'full' | 'new'; id: number; total: number; answered: number; correct: number; wrong: number; started_at: string; completed_at: string | null; review?: TopicRun; error_reviews?: TopicRun[] };
type TopicLaunch = { reviewParent?: number; newQuestions?: boolean; runId?: number };
type TopicSummary = { remaining: number; repeat_in_progress?: boolean; new_count: number; new_question_ids: string[]; question_titlens: Record<string, number>; completed: boolean; runs: TopicRun[]; total: number; answered: number; correct: number; wrong: number; next_question: number; results: Record<string, boolean> };

function TopicStatistics({ stats, total, onReview }: { stats?: TopicSummary; total: number; onReview: (parent: number) => void }) {
  const t = useT();
  const { preferences } = usePreferences();
  const [anchor, setAnchor] = useState<{ top: number; right: number; bottom?: number } | null>(null);
  const trigger = useRef<HTMLSpanElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function keepOpen() { if (closeTimer.current) clearTimeout(closeTimer.current); }
  function closeSoon() { keepOpen(); closeTimer.current = setTimeout(() => setAnchor(null), 180); }
  function open() {
    keepOpen();
    const rect = trigger.current?.getBoundingClientRect();
    if (rect) setAnchor(rect.top > window.innerHeight / 2
      ? { top: 0, bottom: window.innerHeight - rect.top + 6, right: Math.max(12, window.innerWidth - rect.right) }
      : { top: rect.bottom + 6, right: Math.max(12, window.innerWidth - rect.right) });
  }
  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current); }, []);
  useEffect(() => {
    if (!anchor) return;
    function close(event: KeyboardEvent) { if (event.key === 'Escape') { setAnchor(null); trigger.current?.focus(); } }
    function outside(event: PointerEvent) { if (!trigger.current?.contains(event.target as Node) && !popup.current?.contains(event.target as Node)) setAnchor(null); }
    function scrolled(event: Event) { if (!popup.current?.contains(event.target as Node)) setAnchor(null); }
    document.addEventListener('keydown', close); document.addEventListener('pointerdown', outside); window.addEventListener('scroll', scrolled, true);
    return () => { document.removeEventListener('keydown', close); document.removeEventListener('pointerdown', outside); window.removeEventListener('scroll', scrolled, true); };
  }, [anchor]);
  return <><span className="topic-counts topic-statistics" ref={trigger} tabIndex={0} role="button" aria-label={t("Topic run history")} aria-expanded={!!anchor}
    onMouseEnter={open} onMouseLeave={closeSoon} onFocus={open} onBlur={(event) => { if (!popup.current?.contains(event.relatedTarget as Node)) closeSoon(); }}
    onClick={(event) => { event.preventDefault(); event.stopPropagation(); if (!anchor) open(); }}
    onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); open(); } }}>
    <span>{t("Total:")}{" "}{total}</span><span>{t("Answered:")}{" "}{stats?.answered ?? '…'}</span><span>✓ {stats?.correct ?? '…'}</span><span className="wrong-mark">× {stats?.wrong ?? '…'}</span>
  </span>{anchor && createPortal(<div className="topic-history-popover" ref={popup} role="dialog" aria-label={t("Topic run history")}
    style={{ right: anchor.right, top: anchor.bottom === undefined ? anchor.top : undefined, bottom: anchor.bottom }}
    onMouseEnter={keepOpen} onMouseLeave={closeSoon} onFocus={keepOpen} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node) && !trigger.current?.contains(event.relatedTarget as Node)) closeSoon(); }}>
    <strong>{t("Run history")}</strong>
    {!stats?.runs.length && <p>{t("No practice runs yet.")}</p>}
    {stats?.runs.map((run, index) => <section key={run.id}><b>{run.kind === 'new' ? t("New questions") : t('Run {number}', {number: stats.runs.slice(index).filter((item) => item.kind === 'full').length})}</b><time>{new Date(run.started_at).toLocaleString(preferences.interfaceLanguage === 'ru' ? 'ru-RU' : preferences.interfaceLanguage === 'es' ? 'es-ES' : 'en-GB')}</time>
      <p>{run.completed_at ? t("Completed") : t("In progress")} · {run.answered}/{run.total} · ✓ {run.correct} · × {run.wrong}</p>{!!run.inherited && <p>{t("Previously answered in other topics:")}{" "}{run.inherited}</p>}
      {run.error_reviews?.map(review=><div key={review.id}><p>{t("Topic mistake review:")}{" "}{review.completed_at?t("completed"):t("in progress")} · {review.answered}/{review.total} · ✓ {review.correct} · × {review.wrong}</p><time>{new Date(review.started_at).toLocaleString(preferences.interfaceLanguage === 'ru' ? 'ru-RU' : preferences.interfaceLanguage === 'es' ? 'es-ES' : 'en-GB')}</time><button type="button" onClick={()=>{setAnchor(null);onReview(-review.id);}}>{t("View mistake review")}</button></div>)}
      {run.review ? <><p>{t("Mistake review:")}{" "}{run.review.completed_at ? t("completed") : t("in progress")} · {run.review.answered}/{run.review.total} · ✓ {run.review.correct} · × {run.review.wrong}</p>
        {run.review.completed_at && <time>{t("Completed:")}{" "}{new Date(run.review.completed_at).toLocaleString(preferences.interfaceLanguage === 'ru' ? 'ru-RU' : preferences.interfaceLanguage === 'es' ? 'es-ES' : 'en-GB')}</time>}<button type="button" onClick={() => { setAnchor(null); onReview(run.id); }}>{run.review.completed_at ? t("View mistake review") : t("Continue mistake review")}</button></>
        : run.completed_at && run.wrong > 0 ? <button type="button" onClick={() => { setAnchor(null); onReview(run.id); }}>{t("Review mistakes")}</button> : <p>{run.completed_at ? t("No mistakes") : t("Mistake review is available after completion")}</p>}
    </section>)}
  </div>, document.body)}</>;
}

function PageLoader() {
  const t = useT();
  return <main className="page-loading" role="status" aria-label={t("Loading")}><span className="page-spinner" aria-hidden="true" /></main>;
}

function SectionNavigator({ library, sectionId, onOpenTopic }: {
  library: LibraryData;
  sectionId: string; onOpenTopic: (id: string, question?: string, options?: TopicLaunch) => void;
}) {
  const t = useT();
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const section = library.nodes.find((node) => node.id === sectionId);
  function keepOpen() { if (timer.current) clearTimeout(timer.current); }
  function closeSoon() { keepOpen(); timer.current = setTimeout(() => { if (!document.querySelector('.topic-history-popover:hover')) setAnchor(null); }, 180); }
  function open() {
    keepOpen();
    const rect = trigger.current?.getBoundingClientRect();
    if (rect) setAnchor({ left: Math.max(12, Math.min(rect.left, window.innerWidth - 652)), top: rect.bottom + 8 });
  }
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  useEffect(() => {
    if (!anchor) return;
    function close(event: KeyboardEvent) { if (event.key === 'Escape') { setAnchor(null); trigger.current?.focus(); } }
    function outside(event: PointerEvent) { if (!(event.target as Element).closest('.topic-history-popover') && !trigger.current?.contains(event.target as Node) && !popup.current?.contains(event.target as Node)) setAnchor(null); }
    document.addEventListener('keydown', close); document.addEventListener('pointerdown', outside);
    return () => { document.removeEventListener('keydown', close); document.removeEventListener('pointerdown', outside); };
  }, [anchor]);
  return <><button className="section-navigation-trigger" type="button" ref={trigger} aria-haspopup="dialog" aria-expanded={!!anchor}
    onMouseEnter={open} onMouseLeave={closeSoon} onFocus={(event) => { if (!popup.current?.contains(event.relatedTarget as Node)) open(); }} onClick={open}
    onBlur={(event) => { if (!popup.current?.contains(event.relatedTarget as Node)) closeSoon(); }}>{section?.label}</button>
    {anchor && createPortal(<div className="section-navigation-popup" role="dialog" aria-label={section?.label} ref={popup}
      style={{ left: anchor.left, top: anchor.top, maxHeight: `calc(100dvh - ${anchor.top + 16}px)` }}
      onMouseEnter={keepOpen} onMouseLeave={closeSoon} onFocus={keepOpen}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node) && !trigger.current?.contains(event.relatedTarget as Node)) closeSoon(); }}>
      <header><strong>{section?.label}</strong><button type="button" aria-label={t("Close section")} onClick={() => setAnchor(null)}>×</button></header>
      <QuestionLibrary sectionId={sectionId} library={library}
        view={{ search: '', expanded: [sectionId], scrollTop: 0 }} onRemember={() => undefined}
        onOpenTopic={(id, question, options) => { setAnchor(null); onOpenTopic(id, question, options); }} />
    </div>, document.body)}</>;
}

function TopicHeading({ section, title }: { section: React.ReactNode; title: string }) {
  return <><div className="section-heading">{section}</div><div className="theme-heading"><h1>{title}</h1></div></>;
}
type LibraryView = { recentTopic?: string; searchScope?: SearchScope; search: string; expanded: string[]; scrollTop: number; completedTopic?: { id: string; question: string } };

function TopicQuestionList({children}:{children:React.ReactNode}) {
  const t = useT();
  return <details className="topic-questions-disclosure"><summary><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 7 6 5 6-5M6 13l6 5 6-5"/></svg><span className="question-list-closed">{t("Show question list")}</span><span className="question-list-open">{t("Hide question list")}</span></summary>{children}</details>;
}

function QuestionLibrary({ library, onOpenTopic, view, onRemember, sectionId, onStatistics }: {
  library: LibraryData; onOpenTopic: (id: string, question?: string, options?: TopicLaunch) => void;
  onStatistics?: () => void; sectionId?: string; view: LibraryView; onRemember: (snapshot: LibraryView) => void;
}) {
  const t = useT();
  const { preferences } = usePreferences();
  const [sectionChoice, setSectionChoice] = useState<string | null>(null);
  useEffect(() => { const reset = () => setSectionChoice(null); window.addEventListener('default-section-changed', reset); return () => window.removeEventListener('default-section-changed', reset); }, []);
  const roots = library.nodes.filter(node => !node.parent_id);
  const recentId = view.recentTopic;
  let recentNode = library.nodes.find(node => node.id === recentId);
  while (recentNode?.parent_id) recentNode = library.nodes.find(node => node.id === recentNode?.parent_id);
  const selectedSection = sectionChoice ?? recentNode?.id ?? preferences.defaultSection;
  const selectedRoot = roots.find(node => node.id === selectedSection);
  const visibleNodes = selectedRoot && !sectionId ? library.nodes.filter(node => {
    let current: TopicNode | undefined = node;
    while (current) { if (current.id === selectedRoot.id) return true; current = library.nodes.find(parent => parent.id === current?.parent_id); }
    return false;
  }) : library.nodes;
  const visibleIds = new Set(visibleNodes.map(node => node.id));
  const visibleQuestions = library.questions.filter(question => question.topic_ids.some(id => visibleIds.has(id)));
  const displayedRoots = sectionId ? library.nodes.filter(node => node.id === sectionId) : libraryRoots(visibleNodes, '', preferences.hideSingleRoot);
  const root = useRef<HTMLElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const [search, setSearch] = useState(view.search);
  const [searchScope,setSearchScope]=useState<SearchScope>(view.searchScope??defaultSearchScope);
  const [expanded, setExpanded] = useState(view.expanded);
  const [summaries, setSummaries] = useState<Record<string, TopicSummary> | null>(null);
  const [progressError, setProgressError] = useState('');
  const [returnReady,setReturnReady]=useState(()=>Boolean(sectionId)||!(view.recentTopic||view.completedTopic));
  useEffect(() => {
    let active = true;
    void api<Record<string, TopicSummary>>('/api/topics/progress').then((data) => { if (active) setSummaries(data); }).catch(() => { if (active) setProgressError('Could not load progress. Refresh the page to continue this topic.'); });
    return () => { active = false; };
  }, []);
  // Reveal the dashboard only after its final layout and target scroll are ready.
  useLayoutEffect(() => {
    const container = scroll.current;
    if (!container) return;
    container.scrollTop = view.scrollTop;
    const targetId=view.recentTopic??view.completedTopic?.id;
    if(targetId&&!summaries&&!progressError)return;
    if(targetId){
      const branch=Array.from(container.querySelectorAll<HTMLElement>('[data-library-id]')).find(item=>item.dataset.libraryId===targetId);
      if(branch)container.scrollTop+=branch.getBoundingClientRect().top-container.getBoundingClientRect().top-24;
    }
    let reveal=0;
    const layout=requestAnimationFrame(()=>{reveal=requestAnimationFrame(()=>setReturnReady(true));});
    return()=>{cancelAnimationFrame(layout);cancelAnimationFrame(reveal);};
  }, [summaries,progressError,view.scrollTop,view.completedTopic,view.recentTopic]);

  function toggleBranch(id: string, open: boolean) {
    setExpanded((current) => open ? current.includes(id) ? current : [...current, id] : current.includes(id) ? current.filter((item) => item !== id) : current);
  }
  function rememberView() {
    onRemember({
      recentTopic:view.recentTopic, completedTopic:view.completedTopic, search, searchScope, scrollTop: scroll.current?.scrollTop ?? 0,
      expanded: Array.from(root.current?.querySelectorAll<HTMLDetailsElement>('details[data-library-id][open]') ?? []).map((node) => node.dataset.libraryId!),
    });
  }
  function openTopic(id: string, question?: string, options?: TopicLaunch) { rememberView(); onOpenTopic(id, question, options); }
  async function repeatTopic(id: string) {
    try { await api(`/api/topics/${encodeURIComponent(id)}/reset`, { method: 'POST' }); openTopic(id); }
    catch (err) { setProgressError(err instanceof Error ? err.message : 'Could not start a new run'); }
  }
  const query = search.trim().toLocaleLowerCase();
  const textMatches=(text:string)=>text.toLocaleLowerCase().includes(query);
  const matches = (q:LibraryQuestion)=>textMatches(contentWordings(q.question || q.question_title || '', q.translations, preferences.contentLanguages).map(item => item.text).join("\n"));
  const nodeMatches=(node:TopicNode)=>Boolean(query&&(node.parent_id?searchScope.subtopics:searchScope.topics)&&textMatches(node.label));
  const branchMatches=(node:TopicNode):boolean=>nodeMatches(node)||(searchScope.questions&&library.questions.some(q=>q.topic_ids.includes(node.id)&&matches(q)))||library.nodes.some(child=>child.parent_id===node.id&&branchMatches(child));
  function questionList(items: LibraryQuestion[], node: TopicNode, showAll=false) {
    const sorted = [...items].sort((a,b)=>a.canonical_id.localeCompare(b.canonical_id));
    return <div className="library-questions">{sorted.map((q,index)=>({q,index})).filter(({q})=>!query||showAll||(searchScope.questions&&matches(q))).map(({q,index})=>{
      const result=summaries?.[node.id]?.results[q.canonical_id];
      return <button type="button" key={q.canonical_id} data-question-id={q.canonical_id} onClick={()=>{
        const stats=summaries?.[node.id];
        const options:TopicLaunch=stats?.new_question_ids.includes(q.canonical_id)?{newQuestions:true}:{runId:stats?.question_titlens[q.canonical_id]};
        openTopic(node.id,q.canonical_id,options);
      }}><span className="library-question-id topic-question-row"><b className="topic-list-number">{index+1}</b><span className="library-question-title"><SearchText text={contentWordings(q.question || q.question_title || '', q.translations, preferences.contentLanguages).map(item => item.text).join('\n')} query={query} enabled={searchScope.questions}/></span><i className={result===false?'wrong-mark':''}>{result===undefined?'':result?'✓':'×'}</i></span></button>;
    })}</div>;
  }
  function topic(node: TopicNode, ancestorMatch=false): React.ReactNode {
    const children = library.nodes.filter((n) => n.parent_id === node.id);
    const ids = new Set([node.id, ...children.map((n) => n.id)]);
    const items = library.questions.filter((q) => q.topic_ids.some((id) => ids.has(id)));
    const own = items.filter((q) => q.topic_ids.includes(node.id));
    const count = new Set(items.filter((q) => q.verified).map((q) => q.canonical_id)).size;
    const stats = summaries?.[node.id];
    const reviewState=topicReviewState(stats?.runs??[]);
    const hasErrors=!!stats?.wrong;
    const continuation=stats?topicContinuation({...stats,total:count},t):null;
    const reviewPrimary=continuation?.target==='repeat'&&hasErrors;
    const chipLabel=reviewPrimary?topicErrorLabel(stats?.wrong??0,t):continuation?.label;
    const chipTooltip=reviewPrimary?'Review all currently incorrect answers in this topic. Correct answers remove questions from the mistake list.':continuation?.tooltip;
    if(query&&!ancestorMatch&&!branchMatches(node))return null;
    const titleMatch=ancestorMatch||nodeMatches(node);
    const recent=!sectionId&&view.recentTopic===node.id;
    const branchProgress=topicBranchProgress(node.id,library.nodes,summaries);
    return <details className={`library-branch ${children.length ? 'library-section' : ''} ${recent?'recent-topic':''}`} key={node.id} data-library-id={node.id} open={!!query || expanded.includes(node.id)} onToggle={(event) => { if (!event.currentTarget.open) event.currentTarget.querySelectorAll<HTMLDetailsElement>('.topic-questions-disclosure').forEach(list=>{list.open=false;}); if (!query) toggleBranch(node.id, event.currentTarget.open); }}><summary>{recent&&<span className="recent-topic-label" role="note">{t("You recently practiced this topic")}</span>}<span className="library-node-title"><SearchText text={node.label} query={query} enabled={node.parent_id?searchScope.subtopics:searchScope.topics}/></span>{children.length ? <span className="topic-counts"><span>{t("Topics:")}{" "}{branchProgress.total}</span><span>{t("Completed:")}{" "}{summaries ? branchProgress.completed : '…'}</span></span> : <TopicStatistics stats={stats} total={count} onReview={(parent) => openTopic(node.id, undefined, { reviewParent: parent })} />}</summary>
      <div className="library-children">{!children.length && count > 0 && <div className="topic-start-actions"><div className="topic-start-primary"><button type="button" className="primary library-start" disabled={!stats} onClick={() => {
        if(continuation?.target==='repeat'&&hasErrors){openTopic(node.id,undefined,{reviewParent:-1});return;}
        if(continuation?.target==='repeat'){void repeatTopic(node.id);return;}
        openTopic(node.id,undefined,continuation?.target==='new'?{newQuestions:true}:undefined);
      }}>{continuation?.target==='repeat'?(hasErrors?t("Mistake review"):t("Practice topic again")):continuation?.target==='new'?t("Practice new questions"):t("Continue topic")}</button>{continuation&&<span className="topic-continuation-chip" tabIndex={0} title={chipTooltip ? t(chipTooltip) : undefined} aria-label={`${chipLabel}. ${chipTooltip ? t(chipTooltip) : ""}`}>{chipLabel ? t(chipLabel) : null}</span>}{!hasErrors&&reviewState.completed && <span className="topic-review-completed">{t("✓ Mistake review completed")}</span>}</div>
      {hasErrors&&continuation?.target!=='repeat'&&<button type="button" className="repeat-full-topic" onClick={()=>openTopic(node.id,undefined,{reviewParent:-1})}>{t("Mistake review ·")}{" "}{stats?.wrong}</button>}
</div>}{children.map(child=>topic(child,titleMatch))}{!children.length && count>0 && <TopicQuestionList>{questionList(own, node,titleMatch)}</TopicQuestionList>}{!count && <p className="library-empty">{t("Questions will appear as this collection grows.")}</p>}</div>
    </details>;
  }
  return <main className={`library-page ${sectionId ? 'section-library' : ''} ${returnReady?'':'restoring-library'}`} ref={root} aria-busy={!returnReady}>
    {!returnReady&&<div className="library-restore-message" role="status"><span>{t("Returning to your topic")}</span><QuestionLoader /></div>}
    {!sectionId && <>
    <header className="library-header"><a href="/" className="library-brand">{preferences.siteHeading.trim() || "Remember Freely"}</a></header>
    <section className="library-intro"><h1>{t("Choose a topic to practice")}</h1>
      <div className="library-totals"><span><strong>{visibleQuestions.length}</strong> {" "}{t("questions")}</span><span><strong>{visibleNodes.filter(node=>!visibleNodes.some(child=>child.parent_id===node.id)).length}</strong> {" "}{t("topics")}</span><button className="dashboard-statistics" onClick={()=>{rememberView();onStatistics?.();}}>{t("Statistics ↗")}</button></div>
      {roots.length > 1 && <label className="section-picker"><span>{t("Section")}</span><select value={selectedRoot?.id ?? ''} onChange={e => setSectionChoice(e.target.value)}><option value="">{t("All sections")}</option>{roots.map(node => <option value={node.id} key={node.id}>{topicLabel(node, preferences.topicLanguage, preferences.interfaceLanguage)}</option>)}</select></label>}
      <LibrarySearch value={search} onChange={setSearch} scope={searchScope} onScope={setSearchScope} container={scroll} resultKey={summaries?'loaded':'loading'}/>
    </section>
    <div className="library-divider">{t("By topic")}{" "}<span>{t("A question can belong to multiple topics")}</span></div>
    </>}
    {progressError && <p className="answer-error" role="alert">{t(progressError)}</p>}
    <div className="library-tree library-scroll" ref={scroll}>{library.questions.length === 0 && <section className="library-empty"><h2>{t("No questions yet")}</h2><p>{t("Question packs are installed separately. Ask your administrator to install a pack, and its topics will appear here.")}</p></section>}{displayedRoots.map((node) => { const content = topic(node); return content ? <div className="library-root" key={node.id}>{content}</div> : null; })}</div>
  </main>;
}

type TopicAnswerProgress = { selected_letter: string; correct_letter: string; correct: boolean };
type TopicQuestion = { translations?: Record<string, string>; id: string; number: number; question: string; question_title?: string; image_url: string; images?: string[]; help: Record<string, string>; answers: Answer[]; progress?: TopicAnswerProgress };
type TopicRecord = { numbering_total?: number; run_id: number; kind: 'full' | 'new'; id: string; title: string; questions: TopicQuestion[] };

// Prepare the illustration before switching; failed images never block navigation.
function prepareQuestionImage(url: string | null | undefined, signal: AbortSignal) {
  if (!url || signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const image = new Image();
    const finish = () => {
      window.clearTimeout(timeout);
      image.onload = null;
      image.onerror = null;
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timeout = window.setTimeout(finish, 10000);
    signal.addEventListener('abort', finish, { once: true });
    image.onload = finish;
    image.onerror = finish;
    image.src = url;
    if (image.complete) finish();
  });
}

function QuestionLoader() {
  return <span className="question-loader" aria-hidden="true"><span /><span /><span /></span>;
}
function AnswerSaving({loading}:{loading:boolean}) {
  const t = useT();
  return loading ? <span className="answer-saving" role="status" aria-label={t("Saving answer")}><QuestionLoader /></span> : null;
}

function NextQuestionButton({ label = 'Next question →', disabled, imageUrl, onNext }: {
  label?: string; disabled: boolean; imageUrl?: string | null; onNext: () => void;
}) {
  const t = useT();
  const [preparing, setPreparing] = useState(false);
  const [pending, startTransition] = useTransition();
  const navigation = useRef<AbortController | null>(null);
  useEffect(() => () => navigation.current?.abort(), []);
  const loading = preparing || pending;
  async function next() {
    if (disabled || loading || navigation.current) return;
    const controller = new AbortController();
    navigation.current = controller;
    setPreparing(true);
    // Give the busy state a paint before preparing and rendering the next question.
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    await prepareQuestionImage(imageUrl, controller.signal);
    if (controller.signal.aborted) return;
    startTransition(() => {
      onNext();
      setPreparing(false);
    });
    navigation.current = null;
  }
  return <button className="primary next next-loading-button" type="button" disabled={disabled || loading}
    title={t(label)} aria-busy={loading} aria-label={loading ? t("Loading next question") : t(label)} onClick={() => void next()}>
    <span className="next-button-label" aria-hidden={loading}>{t(label)}</span>
    {loading && <QuestionLoader />}
  </button>;
}

function AnswerResult({ correct, letter, onHelp }: { correct: boolean; letter: string; onHelp: () => void }) {
  const t = useT();
  return <aside className={`feedback anchored-feedback ${correct ? 'success' : 'error'}`} aria-live="polite"><div className="feedback-title"><div className="feedback-outcome"><span aria-hidden="true">{correct ? '✓' : '×'}</span><strong>{correct ? t("Correct") : t('Incorrect · correct answer {letter}', {letter})}</strong></div><div className="feedback-actions"><button type="button" className="feedback-help-button" aria-label={t("Show explanation")} onClick={onHelp}>?</button></div></div></aside>;
}

function TopicTrainer({ topicId, initialQuestion, reviewParent, newQuestions, runId, path, displayTitle, sectionNavigation, onQuestion, onBack, onFinish }: {
  topicId: string; initialQuestion?: string; reviewParent?: number; newQuestions?: boolean; runId?: number; path: string; displayTitle?: string; sectionNavigation: React.ReactNode; onQuestion: (question: string, replace?: boolean, runId?: number, reviewParent?: number) => void; onBack: () => void; onFinish: (question: string) => void;
}) {
  const t = useT();
  const { preferences } = usePreferences();
  const [requestedQuestion] = useState(initialQuestion);
  const [topic, setTopic] = useState<TopicRecord | null>(null);
  const [reviewID, setReviewID] = useState<number | undefined>();
  const [initialPosition, setPosition] = useState(0);
  const requestedPosition = topic?.questions.findIndex((item) => item.id === initialQuestion) ?? -1;
  const position = requestedPosition >= 0 ? requestedPosition : initialPosition;
  const [menuOpen, setMenuOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pendingAnswer,setPendingAnswer]=useState<{question:string;letter:string}|null>(null);
  const [error, setError] = useState('');
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let active = true;
    void (async () => {
      const review = reviewParent && reviewParent < -1 ? {id:-reviewParent} : reviewParent ? await api<{ id: number }>(`/api/topics/${encodeURIComponent(topicId)}/${reviewParent===-1?'error-reviews':`reviews/${reviewParent}`}`, { method: 'POST' }) : undefined;
      const newRun = newQuestions && !review ? await api<{ id: number }>(`/api/topics/${encodeURIComponent(topicId)}/new`, { method: 'POST' }) : undefined;
      const requestedRun = newRun?.id ?? runId;
      const loaded = await api<TopicRecord>(`/api/topics/${encodeURIComponent(topicId)}${review ? `?review=${review.id}` : requestedRun ? `?run=${requestedRun}` : ''}`);
      return { loaded, review };
    })().then(({ loaded, review }) => {
      if (!active) return;
      setTopic(loaded);
      setReviewID(review?.id);
      const requested = loaded.questions.findIndex((q) => q.id === requestedQuestion);
      const unanswered = loaded.questions.findIndex((q) => !q.progress);
      setPosition(requested >= 0 ? requested : unanswered >= 0 ? unanswered : 0);
    }).catch((err: unknown) => { if (active) setError(err instanceof Error ? err.message : 'Could not load the topic'); });
    return () => { active = false; };
  }, [topicId, requestedQuestion, reviewParent, newQuestions, runId]);
  useEffect(() => {
    if (!topic) return;
    const requested = topic.questions.findIndex((item) => item.id === initialQuestion);
    if ((requested < 0 || reviewParent===-1) && topic.questions[position]) onQuestion(topic.questions[position].id, true, reviewParent ? undefined : topic.run_id, reviewParent===-1&&reviewID?-reviewID:undefined);
  }, [initialQuestion, topic, position, onQuestion, reviewParent, reviewID]);
  useEffect(() => { panel.current?.scrollTo({ top: 0 }); panel.current?.parentElement?.scrollTo({ top: 0 }); }, [position]);
  useEffect(() => {
    function close(event: KeyboardEvent) { if (event.key === 'Escape') setMenuOpen(false); }
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, []);
  function goTo(index: number) { if (topic?.questions[index]) onQuestion(topic.questions[index].id, false, reviewParent ? undefined : topic.run_id); setHelpOpen(false); }
  async function answer(letter: string) {
    const question = topic?.questions[position];
    if (!question || question.progress || busy) return;
    setBusy(true); setPendingAnswer({question:question.id,letter}); setError('');
    try {
      const result = await api<TopicAnswerProgress>(`/api/topics/${encodeURIComponent(topicId)}/answers`, { method: 'POST', body: JSON.stringify({ question_id: question.id, selected_letter: letter, review_id: reviewID, run_id: reviewID ? undefined : topic?.run_id }) });
      setTopic((current) => current ? { ...current, questions: current.questions.map((q) => q.id === question.id ? { ...q, progress: result } : q) } : null);
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not save your answer'); }
    finally { setBusy(false); setPendingAnswer(null); }
  }
  const q = topic?.questions[position];
  if (!topic || !q) return error ? <main className="loading error-message"><p role="alert">{t(error)}</p><button className="secondary" onClick={onBack}>{t("Learning dashboard")}</button></main> : <PageLoader />;
  const title = displayTitle || topic.title;
  const total = topic.questions.length;
  const done = topic.questions.filter((item) => item.progress).length;
  const correct = topic.questions.filter((item) => item.progress?.correct).length;
  const filteredRun = !!reviewParent || topic.kind === 'new';
  const finishReady = done === total;
  const nextUnanswered = topic.questions.findIndex((item, index) => index > position && !item.progress);
  const nextPosition = nextUnanswered >= 0 ? nextUnanswered : topic.questions.findIndex((item) => !item.progress);
  const previousPosition = position-1;
  const progress = Math.round(done / total * 100);
  const help = contentWordings(Object.values(q.help).find(Boolean) || '', q.help, preferences.contentLanguages).map(item => item.text).join('\n\n');
  return <TrainingFrame>
    <button className="library-back topic-back" type="button" disabled={busy} onClick={onBack}>{t("‹ Learning dashboard")}</button>
    <main className="app-shell topic-shell">
      <header className="topbar topic-topbar">
        <div className="title-block"><TopicHeading section={sectionNavigation} title={title} />{filteredRun && <p className="review-mode-label">{reviewParent ? t("Mistake review · correct your answers") : t("New questions · a separate practice run")}</p>}</div>
        <div className="header-tools">
          <div className="question-menu-shell topic-menu-shell">
            <button type="button" className="question-menu-trigger" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}><span className="question-menu-trigger-copy"><span className="question-menu-trigger-label">{t("Current question")}</span><span className="question-menu-trigger-title">{t("Question")}{" "}{q.number} {" "}{t("of")}{" "}{topic.numbering_total??total}</span></span><span className="question-menu-chevron">⌄</span></button>
            {menuOpen && <><button className="question-menu-backdrop" aria-label={t("Close question list")} onClick={() => setMenuOpen(false)} /><section className="question-menu-panel topic-menu" aria-label={t('Questions in topic {topic}', {topic: title})}><header><div><div className="menu-topic-heading"><p className="menu-section">{path}</p><div className="menu-theme"><strong>{title}</strong></div></div><p className="topic-summary-line">{t("Total:")}{" "}{total} {" "}{t("· Answered:")}{" "}{done} {" "}{t("· Correct:")}{" "}{correct} {" "}{t("· Incorrect:")}{" "}{done - correct}</p></div><button aria-label={t("Close")} onClick={() => setMenuOpen(false)}>×</button></header><div className="question-menu-list">
              {topic.questions.map((item, index) => <button key={item.id} type="button" className={`topic-menu-question ${index === position ? 'active' : ''}`} onClick={() => { goTo(index); setMenuOpen(false); }}><b>{item.number}</b><span>{item.question_title || item.question.split('\n').filter(Boolean).at(-1)}</span><i>{item.progress ? item.progress.correct ? '✓' : '×' : '·'}</i></button>)}
            </div></section></>}
          </div>

          <div className="answer-stats"><div className="score"><span>{t("Correct")}</span><strong>{correct}</strong></div><div className="score score-wrong"><span>{t("Incorrect")}</span><strong>{done - correct}</strong></div></div>
        </div>
      </header>
      <div className="progress-row"><span>{t("Question")}{" "}{q.number} {" "}{t("of")}{" "}{topic.numbering_total??total}</span><div className="progress-track"><div style={{ width: `${progress}%` }} /></div><span>{progress}%</span></div>
      <section className="quiz-card">
        <div className="visual-panel"><div className="question-number">#{q.number}</div><div className="visual-media">{(q.images?.length || q.image_url) ? <div className="question-gallery">{(q.images?.length ? q.images : [q.image_url]).map((image, index) => <img key={image} src={image} alt={t('Image {number} for question {question}', {number: index + 1, question: q.number})} />)}</div> : <span className="visual-empty">{t("Question without an image")}</span>}</div></div>
        <div className="question-panel fixed-question-layout">
          <div className="question-content">
          <div className="question-heading-row"><h2><QuestionText text={q.question} translations={q.translations} /></h2></div>
          <div className="answer-scroll" ref={panel}><div className="answers">{q.answers.map((choice) => {
            const state = q.progress ? choice.letter === q.progress.correct_letter ? 'correct' : choice.letter === q.progress.selected_letter ? 'wrong' : 'muted' : '';
            return <button type="button" className={`answer ${state}`} key={choice.letter} disabled={!!q.progress || busy} aria-busy={pendingAnswer?.question===q.id&&pendingAnswer.letter===choice.letter} onClick={() => answer(choice.letter)}><span className="answer-letter">{choice.letter}</span><QuestionText text={choice.text} translations={choice.translations} answer /><AnswerSaving loading={pendingAnswer?.question===q.id&&pendingAnswer.letter===choice.letter}/></button>;
          })}</div>
          {error && <p role="alert" className="answer-error">{t(error)}</p>}

          {done === total && <p className="topic-completed">{reviewParent ? t("Mistake review completed") : topic.kind === 'new' ? t("New questions completed") : t("Topic completed")}{t(". Correct:")}{" "}{correct} {" "}{t("of")}{" "}{total}{t(". You can return to the topic list.")}</p>}
          </div>
          </div>
          <footer className="question-navigation">{q.progress && <AnswerResult correct={q.progress.correct} letter={q.progress.correct_letter} onHelp={() => setHelpOpen(true)} />}<div className="controls topic-controls"><button className="secondary" disabled={previousPosition < 0 || busy} onClick={() => goTo(previousPosition)}>{t("← Previous")}</button><NextQuestionButton key={q.id} label={finishReady ? reviewParent ? t("Finish mistake review") : topic.kind === 'new' ? t("Finish new questions") : t("Finish topic") : t("Next question →")} disabled={busy || !q.progress} imageUrl={topic.questions[nextPosition]?.image_url} onNext={() => finishReady ? onFinish(q.id) : goTo(nextPosition)} /></div>
          <button className="return-link" type="button" disabled={busy} onClick={onBack}><span className="return-arrow" aria-hidden="true">↩</span><span className="return-text">{t("Return")}</span></button></footer>
        </div>
      </section>
    </main>
    {helpOpen && <Modal eyebrow={`${title} · ${t('question {number}', {number: q.number})}`} title={t("Explanation")} onClose={() => setHelpOpen(false)}><HelpContent text={help || t("No explanation is available for this question yet.")} /></Modal>}
  </TrainingFrame>;
}

function TrainerApp() {
  const t = useT();
  const { preferences } = usePreferences();
  const {route,navigate}=useTrainingNavigation();
  const [sourceLibrary,setLibrary]=useState<LibraryData|null>(null);
  const library = useMemo(() => sourceLibrary ? { ...sourceLibrary, nodes: sourceLibrary.nodes.map(node => ({...node, label: topicLabel(node, preferences.topicLanguage, preferences.interfaceLanguage)})) } : null, [sourceLibrary, preferences.topicLanguage, preferences.interfaceLanguage]);
  const [loadError,setLoadError]=useState('');
  const [libraryRevision,setLibraryRevision]=useState(0);
  useEffect(()=>{const refresh=()=>setLibraryRevision(value=>value+1);window.addEventListener('library-imported',refresh);return()=>window.removeEventListener('library-imported',refresh);},[]);
  const [libraryView,setLibraryView]=useState<LibraryView>(()=>window.history.state?.libraryView??{search:'',expanded:[],scrollTop:0});
  useEffect(() => { const reset = () => setLibraryView({search:'', expanded:[], scrollTop:0}); window.addEventListener('default-section-changed', reset); return () => window.removeEventListener('default-section-changed', reset); }, []);
  const home=route.screen==='home';
  useEffect(()=>{
    document.documentElement.classList.toggle('trainer-viewport',!home);
    return()=>document.documentElement.classList.remove('trainer-viewport');
  },[home]);
  useEffect(()=>{
    const controller=new AbortController();
    fetch('/api/library',{cache:'no-store',signal:controller.signal}).then(response=>{
      if(!response.ok)throw Error();return response.json() as Promise<LibraryData>;
    }).then(setLibrary).catch(()=>{if(!controller.signal.aborted)setLoadError('Could not load topics. Refresh the page.');});
    return()=>controller.abort();
  },[libraryRevision]);
  useEffect(()=>{
    const restore=(event:PopStateEvent)=>{
      const saved=event.state?.libraryView;
      if(route.screen==='topic'&&readRoute().screen==='home'&&library){
        const snapshot=topicReturnState(saved??libraryView,route.id,library.nodes);
        setLibraryView(snapshot);window.history.replaceState({...window.history.state,libraryView:snapshot},'');
      }else if(saved)setLibraryView(saved);
    };
    window.addEventListener('popstate',restore);return()=>window.removeEventListener('popstate',restore);
  },[route,library,libraryView]);
  const onQuestion=useCallback((question:string,replace=false,runId?:number,reviewParent?:number)=>{
    if(route.screen==='topic')navigate({...route,question,runId:runId??route.runId,reviewParent:reviewParent??route.reviewParent},replace);
  },[route,navigate]);
  function remember(snapshot:LibraryView){setLibraryView(snapshot);window.history.replaceState({...window.history.state,libraryView:snapshot},'');}
  function openTopic(id:string,question?:string,options?:TopicLaunch){navigate({screen:'topic',id,question,...options});}
  function returnToLibrary(id:string){
    const snapshot=topicReturnState(libraryView,id,library?.nodes??[]);
    navigate({screen:'home'});remember(snapshot);
  }
  if(loadError)return <main className="loading error-message">{t(loadError)}</main>;
  if(!library)return <PageLoader/>;
  if(route.screen==='statistics')return <LinearStatistics onBack={()=>navigate({screen:'home'})} onOpenTopic={id=>{
    const snapshot=topicReturnState(libraryView,id,library.nodes);navigate({screen:'home'});remember(snapshot);
  }}/>;
  if(route.screen==='topic'){
    const node=library.nodes.find(item=>item.id===route.id);
    const ancestors:string[]=[];let parent=node?.parent_id;
    while(parent){const ancestor=library.nodes.find(item=>item.id===parent);if(!ancestor)break;ancestors.unshift(ancestor.label);parent=ancestor.parent_id;}
    return <TopicTrainer key={`${route.id}:${route.reviewParent??(route.newQuestions?'new':'full')}`} topicId={route.id} displayTitle={node?.label} initialQuestion={route.question} reviewParent={route.reviewParent} newQuestions={route.newQuestions} runId={route.runId} path={ancestors.join(' / ')} onQuestion={onQuestion} sectionNavigation={<SectionNavigator library={library} sectionId={node?.parent_id??route.id} onOpenTopic={openTopic}/>} onBack={()=>returnToLibrary(route.id)} onFinish={()=>returnToLibrary(route.id)}/>;
  }
  return <QuestionLibrary library={library} view={libraryView} onRemember={remember} onOpenTopic={openTopic} onStatistics={()=>navigate({screen:'statistics'})}/>;
}

function AuthenticatedApp() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [checkingSession, setCheckingSession] = useState(true);

  useEffect(() => {
    api<AuthUser>('/api/auth/me')
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setCheckingSession(false));
  }, []);

  async function logout() {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
    setUser(null);
  }

  if (checkingSession) return <PageLoader />;
  if (!user) return <LoginScreen onAuthenticated={setUser} />;
  return <><AccountMenu key={`account:${user.id}`} user={user} onLogout={logout} /><TrainerApp key={user.id} /></>;
}

export default function App() {
  return <PreferencesProvider><AuthenticatedApp /></PreferencesProvider>;
}
