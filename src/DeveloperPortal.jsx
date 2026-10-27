import { useState } from 'react';
import {
  Ban, Code2, Copy, ExternalLink, KeyRound, Search, Settings, Upload
} from 'lucide-react';

export default function DeveloperPortal() {
  const [name, setName] = useState('');
  const [write, setWrite] = useState(true);
  const [key, setKey] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState('');
  const [count, setCount] = useState(null);

  const request = async (url, options = {}) => {
    const response = await fetch(url, options);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'La requête a échoué.');
    return payload;
  };

  const createKey = async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      const payload = await request('/api/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, write })
      });
      setKey(payload.apiKey);
      setName('');
      setNotice('Clé créée. Copiez-la maintenant : elle ne sera affichée qu’une seule fois.');
    } catch (error) {
      setNotice(error.message);
    } finally {
      setBusy(false);
    }
  };

  const testKey = async () => {
    if (!key.trim()) return setNotice('Créez une clé ou collez-en une avant le test.');
    setBusy(true);
    try {
      const payload = await request('/api/v1/works?limit=10', {
        headers: { Authorization: `Bearer ${key.trim()}` }
      });
      setCount(payload.data?.length || 0);
      setResult(JSON.stringify(payload, null, 2));
      setNotice(`${payload.data?.length || 0} œuvre(s) reçue(s).`);
    } catch (error) {
      setNotice(error.message);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    if (!key.trim()) return setNotice('Collez la clé à révoquer.');
    if (!window.confirm('Révoquer cette clé ? Les applications qui l’utilisent perdront immédiatement l’accès.')) return;
    setBusy(true);
    try {
      await request('/api/keys/current', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${key.trim()}` }
      });
      setKey('');
      setNotice('Clé révoquée.');
    } catch (error) {
      setNotice(error.message);
    } finally {
      setBusy(false);
    }
  };

  const importFile = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!key.trim()) return setNotice('Collez une clé API avant l’import.');
    setBusy(true);
    try {
      const payload = await request('/api/v1/works/import', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key.trim()}`, 'Content-Type': 'application/json' },
        body: await file.text()
      });
      setNotice(`${payload.imported} œuvre(s) enregistrée(s) sur le serveur.`);
    } catch (error) {
      setNotice(error.message);
    } finally {
      setBusy(false);
    }
  };

  const copyKey = async () => {
    try {
      await navigator.clipboard.writeText(key);
      setNotice('Clé copiée.');
    } catch {
      setNotice('Sélectionnez puis copiez la clé affichée.');
    }
  };

  return <div className="page developer-page">
    <div className="developer-heading">
      <span className="eyebrow"><Code2 size={14} /> MOZILANIM / API</span>
      <h1>Connectez votre site</h1>
      <p>Créez une clé, importez vos œuvres et utilisez les endpoints depuis votre application.</p>
    </div>
    {notice && <div className="source-notice" role="status">{notice}</div>}
    <div className="developer-grid">
      <section className="dev-card">
        <div className="dev-card-heading"><KeyRound size={19} /><div><h2>Créer une clé API</h2><p>La clé brute n’est montrée qu’à sa création.</p></div></div>
        <form className="dev-key-form" onSubmit={createKey}>
          <label className="field"><span>Nom du projet</span><input required maxLength={80} value={name} onChange={(event) => setName(event.target.value)} placeholder="Mon site" /></label>
          <label className="dev-checkbox"><input type="checkbox" checked={write} onChange={(event) => setWrite(event.target.checked)} /><span>Autoriser l’import et la modification de mes œuvres</span></label>
          <button className="primary-button" disabled={busy}><KeyRound size={15} /> CRÉER LA CLÉ</button>
        </form>
        {key && <div className="issued-key">
          <label>Votre clé — copiez-la maintenant, elle ne sera affichée qu’une fois</label>
          <div><input readOnly value={key} onFocus={(event) => event.target.select()} /><button className="secondary-button" onClick={copyKey}><Copy size={14} /> COPIER</button></div>
          <small>Ne mettez jamais la clé dans le JavaScript public de votre site. Utilisez-la côté serveur.</small>
        </div>}
      </section>
      <section className="dev-card">
        <div className="dev-card-heading"><Settings size={19} /><div><h2>Gérer votre clé</h2><p>La clé n’est pas conservée après la fermeture de cette page.</p></div></div>
        <label className="field"><span>Clé API</span><input type="password" autoComplete="off" value={key} onChange={(event) => setKey(event.target.value)} placeholder="moz_…" /></label>
        <div className="catalog-tools-actions">
          <button className="secondary-button" disabled={busy || !key} onClick={testKey}><Search size={14} /> TESTER</button>
          <button className="ghost-button danger-button" disabled={busy || !key} onClick={revoke}><Ban size={14} /> RÉVOQUER</button>
        </div>
        <label className="secondary-button import-json-button"><Upload size={15} /> IMPORTER UN JSON<input type="file" accept=".json,application/json" onChange={importFile} disabled={busy || !key} /></label>
      </section>
    </div>
    <section className="dev-card docs-card">
      <div className="dev-card-heading"><Code2 size={19} /><div><h2>Documentation rapide</h2><p>Limite : 120 requêtes par minute et par clé.</p></div></div>
      <div className="api-endpoint-list">
        <div><span className="method get">GET</span><code>/api/v1/works?q=naruto&amp;kind=anime&amp;page=1&amp;limit=20</code><p>Liste les œuvres de la clé et le catalogue public.</p></div>
        <div><span className="method get">GET</span><code>/api/v1/works/:slug</code><p>Fiche, saisons, versions, lecteurs et épisodes.</p></div>
        <div><span className="method post">POST</span><code>/api/v1/works/import</code><p>Importe jusqu’à 500 œuvres. Clé avec écriture requise.</p></div>
        <div><span className="method get">GET</span><code>/api/anime-sama/planning</code><p>Planning des nouvelles sorties : animés, films, scans, webtoons.</p></div>
        <div><span className="method get">GET</span><code>/api/anime-sama/work?url=URL_DE_FICHE</code><p>Récupère les liens actualisés d’une fiche autorisée.</p></div>
      </div>
      <pre className="api-code"><code>{`const response = await fetch("https://VOTRE-SITE/api/v1/works", {
  headers: { Authorization: "Bearer VOTRE_CLE_API" }
  // Gardez la clé côté serveur, jamais dans le code public.
  // Écriture : POST /api/v1/works/import avec { "works": [...] }
});`}</code></pre>
      <div className="docs-footer"><a href="/api/docs" target="_blank" rel="noreferrer">Documentation JSON complète <ExternalLink size={14} /></a><span>{count === null ? 'Aucun test' : `${count} œuvres reçues`}</span></div>
      {result && <details className="api-result"><summary>Voir le résultat du test</summary><pre>{result}</pre></details>}
    </section>
  </div>;
}
