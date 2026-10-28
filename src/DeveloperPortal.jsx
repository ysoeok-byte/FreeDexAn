import { useEffect, useState } from 'react';
import { AlertCircle, Ban, Check, Code2, Copy, ExternalLink, KeyRound, RefreshCw, Search, Upload } from 'lucide-react';

async function request(url, options = {}) {
  const response = await fetch(url, { credentials: 'include', ...options });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || 'La requête a échoué.');
  return payload;
}

export default function DeveloperPortal({ user, onNotice }) {
  const [keys, setKeys] = useState([]);
  const [name, setName] = useState('');
  const [write, setWrite] = useState(false);
  const [allowedKinds, setAllowedKinds] = useState(['anime', 'film', 'scan', 'webtoon']);
  const [issuedKey, setIssuedKey] = useState('');
  const [testKey, setTestKey] = useState('');
  const [result, setResult] = useState('');
  const [docs, setDocs] = useState(null);
  const [docsError, setDocsError] = useState('');
  const [docsLoading, setDocsLoading] = useState(true);
  const [keysLoading, setKeysLoading] = useState(true);
  const [keysError, setKeysError] = useState('');
  const [busy, setBusy] = useState(false);
  const kindOptions = [
    { id: 'anime', label: 'Animés' },
    { id: 'film', label: 'Films' },
    { id: 'scan', label: 'Scans' },
    { id: 'webtoon', label: 'Webtoons' }
  ];

  const refreshKeys = async () => {
    setKeysError('');
    try {
      const payload = await request('/api/keys');
      setKeys(payload.keys || []);
    } catch (error) {
      setKeysError(error.message);
      onNotice(error.message);
    } finally {
      setKeysLoading(false);
    }
  };
  const refreshDocs = async () => {
    setDocsLoading(true);
    setDocsError('');
    try {
      setDocs(await request('/api/docs'));
    } catch (error) {
      setDocsError(error.message);
    } finally {
      setDocsLoading(false);
    }
  };
  useEffect(() => {
    refreshKeys();
    refreshDocs();
  }, []);

  const createKey = async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      const payload = await request('/api/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, write, allowedKinds })
      });
      setIssuedKey(payload.apiKey);
      setName('');
      setAllowedKinds(['anime', 'film', 'scan', 'webtoon']);
      await refreshKeys();
      onNotice('Clé créée. Copiez-la maintenant : elle ne sera plus affichée.');
    } catch (error) {
      onNotice(error.message);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id) => {
    if (!window.confirm('Révoquer cette clé ? Les applications qui l’utilisent perdront immédiatement l’accès.')) return;
    setBusy(true);
    try {
      await request(`/api/keys/${encodeURIComponent(id)}`, { method: 'DELETE' });
      await refreshKeys();
      onNotice('Clé révoquée.');
    } catch (error) {
      onNotice(error.message);
    } finally {
      setBusy(false);
    }
  };

  const test = async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      const payload = await request('/api/v1/works?limit=10', { headers: { Authorization: `Bearer ${testKey.trim()}` } });
      setResult(JSON.stringify(payload, null, 2));
      onNotice(`${payload.data?.length || 0} œuvre(s) reçue(s).`);
    } catch (error) {
      onNotice(error.message);
    } finally {
      setBusy(false);
    }
  };

  const importJson = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setBusy(true);
    try {
      const payload = await request('/api/v1/works/import', {
        method: 'POST',
        headers: { Authorization: `Bearer ${testKey.trim()}`, 'Content-Type': 'application/json' },
        body: await file.text()
      });
      onNotice(`${payload.imported} œuvre(s) importée(s).`);
    } catch (error) {
      onNotice(error.message);
    } finally {
      setBusy(false);
    }
  };

  const copyKey = async () => {
    try {
      await navigator.clipboard.writeText(issuedKey);
      onNotice('Clé copiée.');
    } catch {
      onNotice('Sélectionnez puis copiez la clé affichée.');
    }
  };

  return <div className="page api-page">
    <section className="api-heading"><span className="eyebrow"><Code2 size={14} /> ESPACE DÉVELOPPEUR</span><h1>API MozAnim</h1><p>Bonjour {user.name}. Une porte d’entrée claire vers le catalogue, les saisons et la lecture.</p></section>
    <div className="api-notice"><ShieldCheckIcon /> Les clés sont personnelles et ne sont affichées qu’une seule fois. Conservez-les dans votre environnement serveur.</div>
    <div className="api-grid">
      <section className="api-card"><div className="api-card-title"><KeyRound size={19} /><div><h2>Créer une clé</h2><p>Chaque clé appartient à votre compte.</p></div></div>
        <form onSubmit={createKey} className="key-form">
          <label className="field"><span>Nom du projet</span><input required maxLength={80} value={name} onChange={(event) => setName(event.target.value)} placeholder="Mon site" /></label>
          <fieldset className="kind-fieldset"><legend>Contenus accessibles avec cette clé</legend><div className="key-kind-options">{kindOptions.map((option) => <label className={`kind-choice ${allowedKinds.includes(option.id) ? 'checked' : ''}`} key={option.id}><input type="checkbox" checked={allowedKinds.includes(option.id)} onChange={() => setAllowedKinds((current) => current.includes(option.id) ? current.filter((value) => value !== option.id) : [...current, option.id])} /><span className="kind-check"><Check size={12} /></span>{option.label}</label>)}</div></fieldset>
          <label className="checkbox-row"><input type="checkbox" checked={write} onChange={(event) => setWrite(event.target.checked)} /><span>Autoriser l’import de nouvelles œuvres</span></label>
          <button className="button primary" disabled={busy || !name.trim() || !allowedKinds.length}><KeyRound size={15} /> Générer une clé</button>
        </form>
        {issuedKey && <div className="issued-key"><label>Votre nouvelle clé, visible uniquement maintenant</label><div><input readOnly value={issuedKey} onFocus={(event) => event.target.select()} /><button className="button" onClick={copyKey}><Copy size={14} /> Copier</button></div><small>Gardez-la côté serveur. Ne la publiez jamais dans le code JavaScript de votre site.</small></div>}
      </section>

      <section className="api-card"><div className="api-card-title"><KeyRound size={19} /><div><h2>Vos clés</h2><p>{keys.length} clé(s) active(s)</p></div></div>
        {keysLoading ? <div className="key-skeletons"><span /><span /><span /></div> : keysError ? <div className="portal-error"><AlertCircle size={16} /><span>{keysError}</span><button className="button small" onClick={refreshKeys}><RefreshCw size={13} /> Réessayer</button></div> : keys.length ? <div className="key-list">{keys.map((key) => {
          const keyKinds = key.allowed_kinds || key.allowedKinds || [];
          return <div className="key-row" key={key.id}><div><strong>{key.name}</strong><span>{key.key_prefix}•••• · {key.scopes?.includes('write') ? 'lecture + import' : 'lecture seule'}</span><div className="key-kind-tags">{keyKinds.length ? keyKinds.map((value) => <small key={value}>{kindOptions.find((option) => option.id === value)?.label || value}</small>) : <small>Tous les contenus</small>}</div></div><button className="icon-danger" onClick={() => revoke(key.id)} disabled={busy} aria-label={`Révoquer ${key.name}`}><Ban size={16} /></button></div>;
        })}</div> : <p className="empty-inline">Aucune clé pour le moment. Créez-en une pour commencer.</p>}
      </section>
    </div>

    <section className="api-card docs-card"><div className="api-card-title"><Code2 size={19} /><div><h2>Documentation</h2><p>120 requêtes par minute et par clé.</p></div></div>
       {docsError && <div className="portal-error"><AlertCircle size={16} /><span>{docsError}</span><button className="button small" onClick={refreshDocs}><RefreshCw size={13} /> Réessayer</button></div>}
       {docsLoading && <div className="docs-loading"><span /><span /></div>}
       {docs && <div className="docs-summary"><p className="docs-intro">{docs.name} · version {docs.version} · authentification Bearer ou X-API-Key</p><pre className="api-code"><code>{JSON.stringify(docs, null, 2)}</code></pre></div>}
      {docs?.endpoints?.length > 0 && <div className="endpoint-list">{docs.endpoints.map((endpoint, index) => <div key={`${endpoint.method}-${endpoint.path}-${index}`}><span className={`method ${String(endpoint.method).toLowerCase()}`}>{endpoint.method}</span><code>{endpoint.path}</code><p>{endpoint.description}</p></div>)}</div>}
      <pre className="api-code"><code>{`const response = await fetch("/api/v1/works?limit=10", {\n  headers: { Authorization: "Bearer VOTRE_CLE_API" }\n});\nconst catalogue = await response.json();`}</code></pre>
      <div className="docs-footer"><a href="/api/docs" target="_blank" rel="noreferrer">Ouvrir la documentation JSON <ExternalLink size={14} /></a><span>Une clé API est requise pour les données protégées.</span></div>
    </section>

    <section className="api-card test-card"><div className="api-card-title"><Search size={19} /><div><h2>Tester une clé</h2><p>Collez une clé existante pour vérifier son accès.</p></div></div>
      <form className="test-form" onSubmit={test}><label className="field"><span>Clé API</span><input type="password" autoComplete="off" value={testKey} onChange={(event) => setTestKey(event.target.value)} placeholder="moz_…" /></label><div className="button-row"><button className="button" disabled={busy || !testKey.trim()}><Check size={14} /> Tester</button><label className="button upload-button"><Upload size={14} /> Importer un JSON<input type="file" accept=".json,application/json" onChange={importJson} disabled={busy || !testKey.trim()} /></label></div></form>
      {result && <details className="api-result"><summary>Afficher le résultat du test</summary><pre>{result}</pre></details>}
    </section>
  </div>;
}

function ShieldCheckIcon() {
  return <span className="notice-shield"><Check size={14} /></span>;
}
