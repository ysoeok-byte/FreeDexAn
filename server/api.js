import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { getPool } from './db.js';
import { getAnimeSamaCatalogue, getAnimeSamaWork } from './anime-sama-api.js';

const validKinds = new Set(['anime', 'film', 'webtoon', 'scan']);
const allKinds = [...validKinds];
const SESSION_COOKIE = 'mozanim_session';
const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const creationLimit = new Map();
const loginLimit = new Map();
const requestLimit = new Map();

const json = (response, status, payload, apiHeaders = false) => {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  if (apiHeaders) {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-API-Key');
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  }
  response.end(JSON.stringify(payload));
};

const readJson = async (request, maxBytes = 5_000_000) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error('La requête dépasse la taille maximale autorisée.');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    const error = new Error('Le corps de la requête doit être un JSON valide.');
    error.statusCode = 400;
    throw error;
  }
};

const hash = (value) => createHash('sha256').update(value).digest('hex');
const cookieValue = (request, name) => {
  const cookies = String(request.headers.cookie || '').split(';');
  const pair = cookies.map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return pair ? decodeURIComponent(pair.slice(name.length + 1)) : '';
};

const getClientIp = (request) =>
  String(request.headers['x-forwarded-for'] || request.socket?.remoteAddress || 'unknown')
    .split(',')[0].trim().slice(0, 80);

const isRateLimited = (store, key, limit, windowMs) => {
  const now = Date.now();
  const old = store.get(key);
  const current = !old || now - old.startedAt >= windowMs ? { startedAt: now, count: 0 } : old;
  current.count += 1;
  store.set(key, current);
  if (store.size > 5000) {
    for (const [entry, data] of store) if (now - data.startedAt > windowMs * 2) store.delete(entry);
  }
  return current.count > limit;
};

const rejectCrossSiteMutation = (request) => {
  const origin = request.headers.origin;
  if (!origin) return false;
  try {
    return new URL(origin).host !== String(request.headers.host || '');
  } catch {
    return true;
  }
};

const setSessionCookie = (request, response, token) => {
  const secure = process.env.NODE_ENV === 'production' || String(request.headers['x-forwarded-proto'] || '').includes('https');
  response.setHeader('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_LIFETIME_MS / 1000}${secure ? '; Secure' : ''}`);
};

const clearSessionCookie = (request, response) => {
  const secure = process.env.NODE_ENV === 'production' || String(request.headers['x-forwarded-proto'] || '').includes('https');
  response.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`);
};

async function sessionUser(request) {
  const token = cookieValue(request, SESSION_COOKIE);
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const result = await getPool().query(
    `SELECT users.id, users.email, users.display_name, users.created_at
     FROM freedex_sessions sessions
     JOIN freedex_users users ON users.id = sessions.user_id
     WHERE sessions.token_hash = $1 AND sessions.expires_at > NOW()
     LIMIT 1`,
    [hash(token)]
  );
  return result.rows[0] || null;
}

async function startSession(request, response, userId) {
  const token = randomBytes(32).toString('hex');
  await getPool().query(
    'INSERT INTO freedex_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, NOW() + INTERVAL \'30 days\')',
    [hash(token), userId]
  );
  setSessionCookie(request, response, token);
}

async function authenticateApiKey(request, requiredScope = 'read') {
  const authorization = String(request.headers.authorization || '');
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  const rawKey = String(request.headers['x-api-key'] || bearer || '');
  if (!/^moz_[a-zA-Z0-9_-]{32,100}$/.test(rawKey)) return null;

  const result = await getPool().query(
    'SELECT id, user_id, name, scopes, allowed_kinds FROM freedex_api_keys WHERE key_hash = $1 AND revoked_at IS NULL LIMIT 1',
    [hash(rawKey)]
  );
  const client = result.rows[0];
  if (!client || !client.scopes.includes(requiredScope)) return null;
  if (isRateLimited(requestLimit, client.id, 120, 60_000)) return { rateLimited: true };
  await getPool().query('UPDATE freedex_api_keys SET last_used_at = NOW() WHERE id = $1', [client.id]);
  return client;
}

const normalizeWork = (value, allowedKinds = allKinds) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Chaque œuvre doit être un objet JSON.');
  const name = String(value.name || value.title || '').trim().slice(0, 240);
  if (!name) throw new Error('Le champ name est obligatoire.');
  const kind = validKinds.has(value.kind) ? value.kind : 'anime';
  if (!allowedKinds.includes(kind)) throw new Error(`Cette clé API n’autorise pas le type « ${kind} ».`);
  const slug = String(value.slug || value.id || name)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 180);
  if (!slug) throw new Error(`Impossible de créer un identifiant pour « ${name} ».`);
  return {
    id: randomUUID(),
    slug,
    kind,
    name,
    sourceUrl: typeof value.sourceUrl === 'string' ? value.sourceUrl.slice(0, 2048) : null,
    payload: { ...value, id: value.id || slug, slug, kind, name }
  };
};

async function saveWorks(owner, input) {
  const works = Array.isArray(input) ? input : [input];
  if (!works.length || works.length > 500) throw new Error('Importez de 1 à 500 œuvres par requête.');
  const normalized = works.map((work) => normalizeWork(work, owner.allowed_kinds || allKinds));
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const saved = [];
    for (const work of normalized) {
      const result = await client.query(
        `INSERT INTO freedex_library (id, slug, owner_key_id, owner_name, kind, name, source_url, payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
         ON CONFLICT (owner_key_id, slug) DO UPDATE SET
           owner_name = EXCLUDED.owner_name,
           kind = EXCLUDED.kind,
           name = EXCLUDED.name,
           source_url = EXCLUDED.source_url,
           payload = EXCLUDED.payload,
           updated_at = NOW()
         RETURNING id, slug, kind, name, source_url, payload, updated_at`,
        [work.id, work.slug, owner.id, owner.name, work.kind, work.name, work.sourceUrl, JSON.stringify(work.payload)]
      );
      saved.push(result.rows[0]);
    }
    await client.query('COMMIT');
    return saved;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function listWorks(url, owner) {
  const query = String(url.searchParams.get('q') || '').trim().slice(0, 120);
  const kind = url.searchParams.get('kind');
  if (kind && !validKinds.has(kind)) throw new Error('Le filtre kind doit être anime, film, webtoon ou scan.');
  const allowedKinds = Array.isArray(owner.allowed_kinds) ? owner.allowed_kinds : allKinds;
  if (kind && !allowedKinds.includes(kind)) {
    const error = new Error(`Cette clé API n’autorise pas le type « ${kind} ».`);
    error.statusCode = 403;
    throw error;
  }
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 50));
  const offset = Math.max(0, (Number(url.searchParams.get('page')) - 1 || 0) * limit);
  const pool = getPool();
  const conditions = ['owner_key_id = $1', 'kind = ANY($2::text[])'];
  const params = [owner.id, allowedKinds];
  if (query) {
    params.push(`%${query}%`);
    conditions.push(`(name ILIKE $${params.length} OR payload->>'description' ILIKE $${params.length})`);
  }
  if (kind) {
    params.push(kind);
    conditions.push(`kind = $${params.length}`);
  }
  const where = `WHERE ${conditions.join(' AND ')}`;
  const importedCount = await pool.query(`SELECT COUNT(*)::int AS count FROM freedex_library ${where}`, params);
  const totalImported = importedCount.rows[0]?.count || 0;
  let catalogue = { items: [], updatedAt: null };
  try {
    catalogue = await getAnimeSamaCatalogue();
  } catch (error) {
    console.error('[api] Catalogue source indisponible:', error.message);
  }
  const sourceItems = (catalogue.items || []).filter((item) =>
    allowedKinds.includes(item.kind || 'anime') &&
    (!query || item.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())) &&
    (!kind || (item.kind || 'anime') === kind)
  );
  const ownSourceUrls = await pool.query(
    'SELECT source_url FROM freedex_library WHERE owner_key_id = $1 AND source_url IS NOT NULL',
    [owner.id]
  );
  const importedSources = new Set(ownSourceUrls.rows.map((row) => row.source_url));
  const uniqueSourceItems = sourceItems.filter((item) => !importedSources.has(item.sourceUrl));
  const pageWorks = [];
  if (offset < totalImported) {
    const pageParams = [...params, Math.min(limit, totalImported - offset), offset];
    const result = await pool.query(
      `SELECT id, slug, owner_name, kind, name, source_url, payload, updated_at
       FROM freedex_library ${where}
       ORDER BY updated_at DESC LIMIT $${pageParams.length - 1} OFFSET $${pageParams.length}`,
      pageParams
    );
    pageWorks.push(...result.rows.map((row) => ({
      ...row.payload, id: row.id, slug: row.slug, owner: row.owner_name, kind: row.kind,
      sourceUrl: row.source_url, updatedAt: row.updated_at
    })));
  }
  const sourceOffset = Math.max(0, offset - totalImported);
  const sourceNeeded = limit - pageWorks.length;
  if (sourceNeeded > 0) pageWorks.push(...uniqueSourceItems.slice(sourceOffset, sourceOffset + sourceNeeded));
  return {
    data: pageWorks,
    pagination: { page: Math.floor(offset / limit) + 1, limit, total: totalImported + uniqueSourceItems.length, imported: totalImported, source: uniqueSourceItems.length },
    sourceUpdatedAt: catalogue.updatedAt || null
  };
}

const endpointDocs = {
  name: 'MozAnim API',
  version: '1',
  authentication: 'Authorization: Bearer VOTRE_CLE_API ou X-API-Key: VOTRE_CLE_API',
  endpoints: [
    { method: 'GET', path: '/api/v1/works', scope: 'read', description: 'Recherche dans le catalogue et les œuvres importées. Paramètres : q, kind, page, limit.' },
    { method: 'GET', path: '/api/v1/works/:slug', scope: 'read', description: 'Fiche, saisons, versions, épisodes et chapitres.' },
    { method: 'POST', path: '/api/v1/works/import', scope: 'write', description: 'Importe ou met à jour jusqu’à 500 œuvres JSON appartenant à cette clé.' },
    { method: 'PUT', path: '/api/v1/works/:slug', scope: 'write', description: 'Met à jour une œuvre de cette clé.' },
    { method: 'DELETE', path: '/api/v1/works/:slug', scope: 'write', description: 'Supprime une œuvre appartenant à cette clé.' },
    { method: 'GET', path: '/api/anime-sama/planning', scope: 'public', description: 'Planning source des sorties anime, films, scans et webtoons.' }
  ]
};

export async function handleApiRequest(request, response) {
  const url = new URL(request.url || '/', 'http://localhost');
  const pathname = url.pathname;
  const isExternalApi = pathname.startsWith('/api/v1/');
  try {
    if (pathname.startsWith('/api/') && request.method === 'OPTIONS') {
      response.statusCode = 204;
      response.setHeader('Access-Control-Allow-Origin', '*');
      response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-API-Key');
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      response.setHeader('Access-Control-Max-Age', '86400');
      response.end();
      return true;
    }
    if (pathname === '/api/health' && request.method === 'GET') {
      json(response, 200, { status: 'ok', service: 'mozanim-api', version: 1 });
      return true;
    }

    if (pathname === '/api/auth/me' && request.method === 'GET') {
      const user = await sessionUser(request);
      json(response, 200, { user: user ? { id: user.id, email: user.email, name: user.display_name } : null });
      return true;
    }

    if (['/api/auth/signup', '/api/auth/login'].includes(pathname) && request.method === 'POST') {
      if (rejectCrossSiteMutation(request)) {
        json(response, 403, { error: 'Requête non autorisée.' });
        return true;
      }
      const isSignup = pathname.endsWith('signup');
      const limit = isSignup ? 5 : 10;
      const windowMs = isSignup ? 60 * 60 * 1000 : 15 * 60 * 1000;
      if (isRateLimited(loginLimit, `${isSignup ? 'signup' : 'login'}:${getClientIp(request)}`, limit, windowMs)) {
        json(response, 429, { error: 'Trop de tentatives. Réessayez plus tard.' });
        return true;
      }
      const body = await readJson(request, 16_000);
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
        json(response, 400, { error: 'Saisissez une adresse e-mail valide.' });
        return true;
      }
      if (password.length < 10 || password.length > 256) {
        json(response, 400, { error: 'Le mot de passe doit contenir entre 10 et 256 caractères.' });
        return true;
      }

      const pool = getPool();
      let user;
      if (isSignup) {
        const name = String(body.name || '').trim().slice(0, 60);
        if (name.length < 2) {
          json(response, 400, { error: 'Le nom doit contenir au moins 2 caractères.' });
          return true;
        }
        const existing = await pool.query('SELECT id FROM freedex_users WHERE email = $1 LIMIT 1', [email]);
        if (existing.rowCount) {
          json(response, 409, { error: 'Un compte existe déjà avec cette adresse e-mail.' });
          return true;
        }
        const salt = randomBytes(16).toString('hex');
        const passwordHash = scryptSync(password, salt, 64).toString('hex');
        const created = await pool.query(
          'INSERT INTO freedex_users (id, email, display_name, password_hash, password_salt) VALUES ($1, $2, $3, $4, $5) RETURNING id, email, display_name',
          [randomUUID(), email, name, passwordHash, salt]
        );
        user = created.rows[0];
      } else {
        const found = await pool.query(
          'SELECT id, email, display_name, password_hash, password_salt FROM freedex_users WHERE email = $1 LIMIT 1',
          [email]
        );
        const candidate = found.rows[0];
        if (!candidate) {
          json(response, 401, { error: 'Adresse e-mail ou mot de passe incorrect.' });
          return true;
        }
        const passwordHash = scryptSync(password, candidate.password_salt, 64);
        const savedHash = Buffer.from(candidate.password_hash, 'hex');
        if (passwordHash.length !== savedHash.length || !timingSafeEqual(passwordHash, savedHash)) {
          json(response, 401, { error: 'Adresse e-mail ou mot de passe incorrect.' });
          return true;
        }
        user = candidate;
      }
      await startSession(request, response, user.id);
      json(response, isSignup ? 201 : 200, { user: { id: user.id, email: user.email, name: user.display_name } });
      return true;
    }

    if (pathname === '/api/auth/logout' && request.method === 'POST') {
      if (rejectCrossSiteMutation(request)) {
        json(response, 403, { error: 'Requête non autorisée.' });
        return true;
      }
      const token = cookieValue(request, SESSION_COOKIE);
      if (/^[a-f0-9]{64}$/.test(token)) {
        await getPool().query('DELETE FROM freedex_sessions WHERE token_hash = $1', [hash(token)]);
      }
      clearSessionCookie(request, response);
      json(response, 200, { loggedOut: true });
      return true;
    }

    if (pathname === '/api/docs' && request.method === 'GET') {
      const user = await sessionUser(request);
      if (!user) {
        json(response, 401, { error: 'Connectez-vous pour consulter la documentation API.' });
        return true;
      }
      json(response, 200, endpointDocs);
      return true;
    }

    if (pathname === '/api/keys' && request.method === 'GET') {
      const user = await sessionUser(request);
      if (!user) {
        json(response, 401, { error: 'Connectez-vous pour gérer vos clés API.' });
        return true;
      }
      const result = await getPool().query(
        'SELECT id, key_prefix, name, scopes, allowed_kinds, created_at, last_used_at FROM freedex_api_keys WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC',
        [user.id]
      );
      json(response, 200, { keys: result.rows });
      return true;
    }

    if (pathname === '/api/keys' && request.method === 'POST') {
      if (rejectCrossSiteMutation(request)) {
        json(response, 403, { error: 'Requête non autorisée.' });
        return true;
      }
      const user = await sessionUser(request);
      if (!user) {
        json(response, 401, { error: 'Connectez-vous avant de créer une clé API.' });
        return true;
      }
      if (isRateLimited(creationLimit, user.id, 10, 60 * 60 * 1000)) {
        json(response, 429, { error: 'Limite de création atteinte. Réessayez dans une heure.' });
        return true;
      }
      const body = await readJson(request, 16_000);
      const name = String(body.name || '').trim().slice(0, 80);
      if (!name) {
        json(response, 400, { error: 'Donnez un nom à ce projet API.' });
        return true;
      }
      const secret = `moz_${randomBytes(36).toString('base64url')}`;
      const id = randomUUID();
      const scopes = body.write === true ? ['read', 'write'] : ['read'];
      const requestedKinds = Array.isArray(body.allowedKinds) ? body.allowedKinds : allKinds;
      const allowedKinds = [...new Set(requestedKinds.filter((kind) => validKinds.has(kind)))];
      if (!allowedKinds.length || allowedKinds.length !== requestedKinds.length) {
        json(response, 400, { error: 'Sélectionnez au moins un type valide : anime, film, scan ou webtoon.' });
        return true;
      }
      const created = await getPool().query(
        'INSERT INTO freedex_api_keys (id, user_id, key_hash, key_prefix, name, scopes, allowed_kinds) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, key_prefix, name, scopes, allowed_kinds, created_at',
        [id, user.id, hash(secret), secret.slice(0, 12), name, scopes, allowedKinds]
      );
      json(response, 201, { ...created.rows[0], apiKey: secret, warning: 'Copiez cette clé maintenant. Elle ne sera plus affichée.' });
      return true;
    }

    if (pathname.startsWith('/api/keys/') && request.method === 'DELETE') {
      if (rejectCrossSiteMutation(request)) {
        json(response, 403, { error: 'Requête non autorisée.' });
        return true;
      }
      const user = await sessionUser(request);
      if (!user) {
        json(response, 401, { error: 'Connectez-vous pour gérer vos clés API.' });
        return true;
      }
      const id = decodeURIComponent(pathname.slice('/api/keys/'.length));
      const result = await getPool().query(
        'UPDATE freedex_api_keys SET revoked_at = NOW() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING id',
        [id, user.id]
      );
      json(response, result.rowCount ? 200 : 404, result.rowCount ? { revoked: true } : { error: 'Clé introuvable.' });
      return true;
    }

    if (pathname === '/api/v1/works' && request.method === 'GET') {
      const client = await authenticateApiKey(request, 'read');
      if (!client) {
        json(response, 401, { error: 'Une clé API valide avec accès lecture est nécessaire.' }, true);
        return true;
      }
      if (client.rateLimited) {
        json(response, 429, { error: 'Limite atteinte : 120 requêtes par minute.' }, true);
        return true;
      }
      const result = await listWorks(url, { ...client, name: client.name });
      response.setHeader('X-RateLimit-Limit', '120');
      response.setHeader('X-RateLimit-Window', '60');
      json(response, 200, result, true);
      return true;
    }

    if (pathname === '/api/v1/works/import' && request.method === 'POST') {
      const client = await authenticateApiKey(request, 'write');
      if (!client) {
        json(response, 401, { error: 'Une clé API avec accès écriture est nécessaire.' }, true);
        return true;
      }
      if (client.rateLimited) {
        json(response, 429, { error: 'Limite atteinte : 120 requêtes par minute.' }, true);
        return true;
      }
      const body = await readJson(request);
      const saved = await saveWorks({ ...client, name: client.name }, body.works ?? body);
      json(response, 200, { imported: saved.length, data: saved }, true);
      return true;
    }

    if (pathname.startsWith('/api/v1/works/') && ['GET', 'PUT', 'DELETE'].includes(request.method)) {
      const slug = decodeURIComponent(pathname.slice('/api/v1/works/'.length)).trim();
      const requiredScope = request.method === 'GET' ? 'read' : 'write';
      const client = await authenticateApiKey(request, requiredScope);
      if (!client) {
        json(response, 401, { error: `Une clé API avec accès ${requiredScope === 'read' ? 'lecture' : 'écriture'} est nécessaire.` }, true);
        return true;
      }
      if (client.rateLimited) {
        json(response, 429, { error: 'Limite atteinte : 120 requêtes par minute.' }, true);
        return true;
      }
      if (request.method === 'GET') {
        const result = await getPool().query(
          'SELECT id, slug, owner_name, kind, name, source_url, payload, updated_at FROM freedex_library WHERE owner_key_id = $1 AND slug = $2 AND kind = ANY($3::text[]) LIMIT 1',
          [client.id, slug, client.allowed_kinds || allKinds]
        );
        if (result.rowCount) {
          const row = result.rows[0];
          const refreshed = row.payload?.isAnimeSama && row.source_url ? await getAnimeSamaWork(row.source_url) : {};
          json(response, 200, { ...row.payload, ...refreshed, id: row.id, slug: row.slug, owner: row.owner_name, kind: row.kind, sourceUrl: row.source_url, updatedAt: row.updated_at }, true);
          return true;
        }
        let catalogue;
        try {
          catalogue = await getAnimeSamaCatalogue();
        } catch {
          catalogue = { items: [] };
        }
        const found = catalogue.items.find((item) =>
          (item.slug === slug || item.id === slug) && (client.allowed_kinds || allKinds).includes(item.kind || 'anime')
        );
        if (!found) json(response, 404, { error: 'Œuvre introuvable.' }, true);
        else if (found.sourceUrl) {
          const detail = await getAnimeSamaWork(found.sourceUrl);
          json(response, 200, { ...detail, kind: found.kind || detail.kind }, true);
        }
        else json(response, 200, found, true);
        return true;
      }
      if (request.method === 'DELETE') {
        const result = await getPool().query(
          'DELETE FROM freedex_library WHERE owner_key_id = $1 AND slug = $2 RETURNING id',
          [client.id, slug]
        );
        json(response, result.rowCount ? 200 : 404, result.rowCount ? { deleted: true } : { error: 'Œuvre introuvable pour cette clé.' }, true);
        return true;
      }
      const body = await readJson(request);
      const saved = await saveWorks({ ...client, name: client.name }, { ...body, slug });
      json(response, 200, saved[0], true);
      return true;
    }
    return false;
  } catch (error) {
    console.error('[api]', error);
    const databaseError = typeof error.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code);
    if (!response.headersSent) json(response, error.statusCode || (databaseError ? 500 : 400), { error: error.message || 'Requête invalide.' }, isExternalApi);
    return true;
  }
}
