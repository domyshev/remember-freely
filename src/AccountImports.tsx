import { useEffect, useRef, useState } from 'react';

type KeyRecord = { id: string; name: string; prefix: string; created_at: string; expires_at: string; revoked_at: string | null; last_used_at: string | null };
type Upload = { id: string; status: string; upload_started_at: string; uploaded_at: string | null; report_created_at: string | null; archive_sha256: string | null; report_sha256: string | null; size_bytes: number };
type UploadPage = { uploads: Upload[]; next_offset: number | null };
const maxBytes = 64 * 1024 * 1024;
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, credentials: 'same-origin', cache: 'no-store', headers: init?.body ? { 'Content-Type': 'application/json' } : undefined });
  if (!response.ok) { const error = await response.json().catch(() => ({})); throw Error(error.error || `HTTP ${response.status}`); }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}
function utc(value: string | null) { return value ? new Date(value).toISOString() : '—'; }

export function AccountImports() {
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => { const timer = window.setInterval(() => setClock(Date.now()), 30000); return () => window.clearInterval(timer); }, []);
  const [keys, setKeys] = useState<KeyRecord[]>([]);
  const [history, setHistory] = useState<Upload[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [name, setName] = useState('');
  const [days, setDays] = useState(30);
  const [secret, setSecret] = useState('');
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState<number | undefined>(0);
  const [phase, setPhase] = useState('');
  const [download, setDownload] = useState<{ url: string; filename: string; sha256: string } | null>(null);
  const upload = useRef<XMLHttpRequest | null>(null);
  const reportURL = useRef('');
  const mounted = useRef(true);
  const endpoint = `${window.location.origin}/api/imports`;
  function loadKeys() { return request<KeyRecord[]>('/api/keys').then(setKeys); }
  function loadHistory(offset = 0) { return request<UploadPage>(`/api/imports?limit=10&offset=${offset}`).then(page => { setHistory(old => offset ? [...old, ...page.uploads] : page.uploads); setNext(page.next_offset); }); }
  useEffect(() => {
    mounted.current = true;
    let active = true;
    Promise.all([request<KeyRecord[]>('/api/keys'), request<UploadPage>('/api/imports?limit=10')]).then(([items, page]) => {
      if (active) { setKeys(items); setHistory(page.uploads); setNext(page.next_offset); }
    }).catch(error => { if (active) setError(String(error.message)); });
    return () => { active = false; mounted.current = false; if (reportURL.current) URL.revokeObjectURL(reportURL.current); };
  }, []);
  useEffect(() => {
    if (!uploading) return;
    const timer = window.setInterval(() => { void loadHistory().catch(() => {}); }, 2000);
    return () => window.clearInterval(timer);
  }, [uploading]);
  async function createKey(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setSecret(''); setCopied(false);
    try {
      const result = await request<{ secret: string }>('/api/keys', { method: 'POST', body: JSON.stringify({ name, expires_at: new Date(Date.now() + days * 86400000).toISOString() }) });
      setSecret(result.secret); setName(''); await loadKeys();
    } catch (error) { setError((error as Error).message); } finally { setBusy(false); }
  }
  async function mutateKey(id: string, action: 'revoke' | 'delete') {
    setBusy(true); setError('');
    try { await request(`/api/keys/${encodeURIComponent(id)}${action === 'revoke' ? '/revoke' : ''}`, { method: action === 'revoke' ? 'POST' : 'DELETE' }); await loadKeys(); }
    catch (error) { setError((error as Error).message); } finally { setBusy(false); }
  }
  async function copySecret() {
    try { await navigator.clipboard.writeText(secret); setCopied(true); } catch { setError('Clipboard unavailable. Select and copy the key manually.'); }
  }
  function startUpload(event: React.FormEvent) {
    event.preventDefault(); if (!file) return;
    if (file.size > maxBytes) { setError('ZIP exceeds 64 MiB.'); return; }
    setError(''); setUploading(true); setProgress(0); setPhase('Uploading ZIP');
    if (reportURL.current) { URL.revokeObjectURL(reportURL.current); reportURL.current = ''; } setDownload(null);
    const xhr = new XMLHttpRequest(); upload.current = xhr;
    xhr.open('POST', '/api/imports'); xhr.setRequestHeader('Content-Type', 'application/zip'); xhr.responseType = 'arraybuffer'; xhr.timeout = 8 * 60 * 1000;
    xhr.upload.onprogress = event => { if (mounted.current) setProgress(event.lengthComputable ? Math.round(event.loaded / event.total * 100) : undefined); };
    xhr.upload.onload = () => { if (mounted.current) { setProgress(100); setPhase('Processing questions and preparing report'); } };
    xhr.onload = () => { void (async () => {
      try {
        const bytes = xhr.response as ArrayBuffer;
        const expected = xhr.getResponseHeader('X-Report-SHA256');
        if (!expected) { let message = `HTTP ${xhr.status}`; try { message = JSON.parse(new TextDecoder().decode(bytes)).error || message; } catch { /* Non-JSON error response. */ } throw Error(message); }
        const actual = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(byte => byte.toString(16).padStart(2, '0')).join('');
        if (actual !== expected) throw Error('Report checksum mismatch. Check import history before retrying.');
        if (!mounted.current) return;
        const id = xhr.getResponseHeader('X-Import-ID') || 'result';
        const url = URL.createObjectURL(new Blob([bytes], { type: 'application/json' })); reportURL.current = url;
        setDownload({ url, filename: `import-${id}.json`, sha256: actual });
        setPhase(xhr.status === 200 ? 'Imported — report ready' : 'Archive rejected — report ready');
        if (xhr.status === 200) window.dispatchEvent(new Event('library-imported'));
        await loadHistory();
      } catch (error) { if (mounted.current) { setError((error as Error).message); setPhase('Upload did not complete successfully'); } }
      finally { if (mounted.current) setUploading(false); upload.current = null; }
    })(); };
    const failed = () => { if (mounted.current) { setError('Connection interrupted. Check history before retrying; the server may have completed the import.'); setPhase('Connection interrupted'); setUploading(false); void loadHistory().catch(() => {}); } upload.current = null; };
    xhr.onerror = failed; xhr.ontimeout = failed; xhr.onabort = failed;
    xhr.send(file);
  }
  return <div className="account-imports">
    {error && <p role="alert" className="error-message">{error}</p>}
    <section aria-labelledby="api-keys-title"><h3 id="api-keys-title">API keys</h3><p>Keys can import questions and read your import history. The full key is shown only when created.</p>
      <form onSubmit={createKey} className="api-key-form"><label>Name<input required maxLength={80} value={name} onChange={event => setName(event.target.value)} placeholder="My import agent" /></label>
        <label>Lifetime (days)<input required type="number" min={1} max={365} value={days} onChange={event => setDays(Number(event.target.value))} /></label><button type="submit" className="primary" disabled={busy}>Create key</button></form>
      {secret && <div className="created-api-key"><p>Copy this key now. It cannot be retrieved later.</p><input aria-label="New API key" readOnly value={secret} autoComplete="off" spellCheck={false} /><div><button type="button" onClick={() => void copySecret()}>{copied ? 'Copied' : 'Copy key'}</button><button type="button" className="secondary" onClick={() => setSecret('')}>Dismiss key</button></div></div>}
      {keys.length === 0 && <p>No API keys yet.</p>}
      {keys.map(key => { const status = key.revoked_at ? 'Revoked' : Date.parse(key.expires_at) <= clock ? 'Expired' : 'Active'; return <article className="api-key-row" key={key.id}><strong>{key.name}</strong><code>{key.prefix}…</code><span>{status}</span><small>Expires (UTC): {utc(key.expires_at)}</small><small>Last used (UTC): {utc(key.last_used_at)}</small><div>{status === 'Active' && <button type="button" className="secondary" disabled={busy} onClick={() => void mutateKey(key.id, 'revoke')}>Revoke</button>}<button type="button" className="secondary" disabled={busy} onClick={() => void mutateKey(key.id, 'delete')}>Delete</button></div></article>; })}
    </section>
    <section aria-labelledby="upload-pack-title"><h3 id="upload-pack-title">Import question pack</h3><p>Choose a ZIP up to 64 MiB. Imported questions are private to your account. Keep settings open until you save the returned report; it is not stored on the server.</p><p className="api-endpoint"><code>{endpoint}</code></p>
      <form onSubmit={startUpload}><label>Question pack ZIP<input required type="file" accept=".zip,application/zip" disabled={uploading} onChange={event => setFile(event.target.files?.[0] || null)} /></label><button type="submit" className="primary" disabled={uploading || !file}>Import ZIP</button></form>
      <div role="status" aria-live="polite">{phase}{uploading && <><progress aria-label="ZIP upload progress" max={100} value={progress} /><span>{progress === undefined ? 'Uploading…' : `${progress}% uploaded`}</span></>}</div>
      {download && <div className="import-report-download"><a href={download.url} download={download.filename}>Download JSON report</a><small>Report SHA-256</small><code>{download.sha256}</code></div>}
    </section>
    <section aria-labelledby="import-history-title"><h3 id="import-history-title">Import history</h3><button type="button" className="secondary" onClick={() => void loadHistory().catch(error => setError(error.message))}>Refresh history</button><p>All times are UTC. ZIP files and reports are not retained.</p>
      {history.length === 0 && <p>No uploads yet.</p>}
      {history.map(item => <article key={item.id} className="import-history-row"><strong>{item.status}</strong><small>Upload started: {utc(item.upload_started_at)}</small><small>ZIP received: {utc(item.uploaded_at)}</small><small>Report created: {utc(item.report_created_at)}</small><small>ZIP SHA-256</small><code>{item.archive_sha256 || '—'}</code><small>Report SHA-256</small><code>{item.report_sha256 || '—'}</code><small>{item.size_bytes.toLocaleString()} bytes</small></article>)}
      {next !== null && <button type="button" className="secondary" onClick={() => void loadHistory(next).catch(error => setError(error.message))}>Load more uploads</button>}
    </section>
  </div>;
}
