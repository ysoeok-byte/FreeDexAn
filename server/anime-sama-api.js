const ANIME_SAMA_BASE_URL = 'https://anime-sama.to';
const CACHE_TTL_MS = 30 * 60 * 1000;
const WORK_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 20_000;
const PAGE_CONCURRENCY = 5;

let catalogueCache = null;
let refreshPromise = null;
let planningCache = null;
let planningPromise = null;
const workCache = new Map();
const forcedRefreshAt = new Map();

const slugify = (value) => String(value || '')
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/(^-|-$)/g, '');

const decodeHtml = (value) => String(value || '')
  .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
  .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
  .replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'")
  .replace(/&#039;/g, "'")
  .replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&nbsp;/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const absoluteUrl = (value, base = ANIME_SAMA_BASE_URL) => {
  try {
    return new URL(value, base).href;
  } catch {
    return '';
  }
};

const imageUrl = (value, base = ANIME_SAMA_BASE_URL) => {
  const href = absoluteUrl(value, base);
  try {
    const url = new URL(href);
    if (url.hostname === 'raw.githubusercontent.com' && url.pathname.startsWith('/Anime-Sama/IMG/img/')) {
      url.hostname = 'cdn.jsdelivr.net';
      url.pathname = url.pathname.replace('/Anime-Sama/IMG/img/', '/gh/Anime-Sama/IMG@img/');
    }
    return url.href;
  } catch {
    return '';
  }
};

const fetchText = async (url, referer = `${ANIME_SAMA_BASE_URL}/`) => {
  let target = safeAnimeSamaUrl(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      const response = await fetch(target, {
        headers: {
          Accept: 'text/html,application/xhtml+xml,*/*',
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          Referer: referer
        },
        signal: controller.signal,
        redirect: 'manual'
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location || redirects === 5) throw new Error('Redirection source invalide.');
        target = safeAnimeSamaUrl(new URL(location, target).href);
        continue;
      }
      if (!response.ok) throw new Error(`La source a répondu ${response.status}.`);
      const finalUrl = safeAnimeSamaUrl(response.url || target);
      return { text: await response.text(), url: finalUrl };
    }
    throw new Error('Trop de redirections de la source.');
  } finally {
    clearTimeout(timer);
  }
};

const safeAnimeSamaUrl = (value) => {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('URL Anime-Sama invalide.');
  }
  if (parsed.protocol !== 'https:' || !['anime-sama.to', 'www.anime-sama.to'].includes(parsed.hostname)) {
    throw new Error('Seules les fiches Anime-Sama autorisées sont acceptées.');
  }
  return parsed.href;
};

const extractAttribute = (attributes, name) => {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = attributes.match(new RegExp(`\\b${escaped}\\s*=\\s*(['"])(.*?)\\1`, 'i'));
  return decodeHtml(match?.[2] || '');
};
const allowForcedRefresh = (key) => {
  const now = Date.now();
  const last = forcedRefreshAt.get(key) || 0;
  if (now - last < 20_000) return false;
  forcedRefreshAt.set(key, now);
  return true;
};

const extractPageCount = (html) => {
  const pages = [...html.matchAll(/href=['"][^'"]*[?&]page=(\d+)['"]/gi)]
    .map((match) => Number(match[1]))
    .filter(Number.isFinite);
  return Math.max(1, ...pages);
};

const extractGenres = (block) => [...block.matchAll(/<span\b[^>]*class=['"][^'"]*genre-tag[^'"]*['"][^>]*>([\s\S]*?)<\/span>/gi)]
  .map((match) => decodeHtml(match[1].replace(/<[^>]*>/g, '')))
  .filter(Boolean)
  .filter((genre) => genre !== '…')
  .filter((genre, index, genres) => genres.indexOf(genre) === index);

const parseCataloguePage = (html) => {
  const items = [];
  const cards = [...html.matchAll(/<div\b(?=[^>]*class=['"][^'"]*as-carte[^'"]*['"])(?=[^>]*\bdata-url=)([^>]*)>/gi)];
  for (const [index, match] of cards.entries()) {
    const attributes = match[1];
    const cardBlock = html.slice(match.index, cards[index + 1]?.index ?? html.length);
    const sourceUrl = absoluteUrl(extractAttribute(attributes, 'data-url'));
    const name = extractAttribute(attributes, 'data-nom');
    const poster = imageUrl(extractAttribute(attributes, 'data-img'));
    const classes = extractAttribute(attributes, 'class').toLowerCase();
    const badgeKind = cardBlock.match(/class=['"][^'"]*as-badge-(anime|film|scan|webtoon)[^'"]*['"]/i)?.[1]?.toLowerCase();
    const kind = badgeKind === 'webtoon' || /webtoon/.test(classes) ? 'webtoon'
      : badgeKind === 'scan' || /as-carte-scan/.test(classes) ? 'scan'
        : badgeKind === 'film' || /film/.test(classes) ? 'film' : 'anime';
    if (!sourceUrl || !name) continue;
    try {
      safeAnimeSamaUrl(sourceUrl);
    } catch {
      continue;
    }
    items.push({
      id: `anime-sama-${slugify(name) || slugify(sourceUrl)}`,
      slug: slugify(name) || slugify(sourceUrl),
      name,
      kind,
      poster,
      backdrop: poster,
      description: '',
      genres: extractGenres(cardBlock),
      year: '',
      isAnimeSama: true,
      sourceUrl,
      seasons: []
    });
  }
  return items;
};

const dedupeItems = (items) => {
  const usedIds = new Set();
  const usedUrls = new Set();
  return items.filter((item) => {
    if (usedUrls.has(item.sourceUrl)) return false;
    usedUrls.add(item.sourceUrl);
    let id = item.id;
    let suffix = 2;
    while (usedIds.has(id)) id = `${item.id}-${suffix++}`;
    usedIds.add(id);
    item.id = id;
    return true;
  });
};

async function refreshCatalogue() {
  const first = await fetchText(`${ANIME_SAMA_BASE_URL}/catalogue`);
  const pageCount = Math.min(extractPageCount(first.text), 100);
  const pages = [first.text];
  for (let page = 2; page <= pageCount; page += PAGE_CONCURRENCY) {
    const batch = Array.from({ length: Math.min(PAGE_CONCURRENCY, pageCount - page + 1) }, (_, index) => page + index);
    const htmlPages = await Promise.all(batch.map(async (number) => (await fetchText(`${ANIME_SAMA_BASE_URL}/catalogue/?page=${number}`)).text));
    pages.push(...htmlPages);
  }
  const items = dedupeItems(pages.flatMap(parseCataloguePage));
  if (!items.length) throw new Error('Le catalogue est vide ou sa structure a changé.');
  catalogueCache = {
    source: ANIME_SAMA_BASE_URL,
    updatedAt: new Date().toISOString(),
    pageCount,
    count: items.length,
    items
  };
  return catalogueCache;
}

export async function getAnimeSamaCatalogue(forceRefresh = false) {
  const fresh = catalogueCache && Date.now() - Date.parse(catalogueCache.updatedAt) < CACHE_TTL_MS;
  if (!forceRefresh && fresh) return catalogueCache;
  if (!refreshPromise) {
    refreshPromise = refreshCatalogue().finally(() => { refreshPromise = null; });
  }
  return refreshPromise;
}

const parisDateTime = (timestampSeconds) => {
  const date = new Date(Number(timestampSeconds) * 1000);
  const parts = new Intl.DateTimeFormat('fr-CA', {
    timeZone: 'Europe/Paris',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const part = (type) => parts.find((entry) => entry.type === type)?.value;
  return {
    date: `${part('year')}-${part('month')}-${part('day')}`,
    time: new Intl.DateTimeFormat('fr-FR', {
      timeZone: 'Europe/Paris',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }).format(date)
  };
};

const parsePlanningPage = (html) => {
  const cards = [...html.matchAll(/<div\b(?=[^>]*class=['"][^'"]*planning-card[^'"]*['"])([^>]*)>/gi)];
  return cards.map((match, index) => {
    const nextStart = cards[index + 1]?.index ?? html.length;
    const cardBlock = html.slice(match.index, nextStart);
    const attributes = match[1];
    const name = extractAttribute(attributes, 'data-nom');
    const sourceUrl = absoluteUrl(extractAttribute(attributes, 'data-url'));
    const image = extractAttribute(attributes, 'data-img');
    const classes = extractAttribute(attributes, 'class').toLowerCase();
    const category = cardBlock.match(/class=['"][^'"]*as-badge-(anime|film|scan|webtoon)[^'"]*['"]/i)?.[1]?.toLowerCase();
    const kind = category === 'webtoon' || /webtoon/.test(classes) ? 'webtoon'
      : category === 'scan' || /as-carte-scan/.test(classes) ? 'scan'
        : category === 'film' || /film/.test(classes) ? 'film' : 'anime';
    const timestamp = extractAttribute(attributes, 'data-release-ts')
      || extractAttribute(attributes, 'data-heure-ts')
      || extractAttribute(attributes, 'data-debut');
    const schedule = timestamp ? parisDateTime(timestamp) : null;
    if (!name || !sourceUrl || !schedule) return null;
    try {
      safeAnimeSamaUrl(sourceUrl);
    } catch {
      return null;
    }
    const day = new Date(`${schedule.date}T12:00:00Z`).getUTCDay();
    return {
      id: `anime-sama-${slugify(name)}-${schedule.date}-${schedule.time.replace(/\D/g, '')}-${index + 1}`,
      slug: slugify(name),
      name,
      kind,
      poster: imageUrl(image),
      sourceUrl,
      schedule: { ...schedule, day },
      isAnimeSama: true
    };
  }).filter(Boolean);
};

async function refreshPlanning() {
  const page = await fetchText(`${ANIME_SAMA_BASE_URL}/planning/`);
  const items = parsePlanningPage(page.text);
  if (!items.length) throw new Error('Le planning source est vide ou sa structure a changé.');
  planningCache = {
    source: page.url,
    updatedAt: new Date().toISOString(),
    count: items.length,
    items
  };
  return planningCache;
}

export async function getAnimeSamaPlanning(forceRefresh = false) {
  const fresh = planningCache && Date.now() - Date.parse(planningCache.updatedAt) < CACHE_TTL_MS;
  if (!forceRefresh && fresh) return planningCache;
  if (!planningPromise) planningPromise = refreshPlanning().finally(() => { planningPromise = null; });
  return planningPromise;
}

const extractTagText = (html, selectors) => {
  for (const selector of selectors) {
    const match = html.match(selector);
    if (match?.[1]) return decodeHtml(match[1].replace(/<[^>]*>/g, ''));
  }
  return '';
};

const extractPanelEntries = (html, pageUrl) => {
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((match) => match[1]);
  const scriptText = scripts.join('\n').replace(/\/\*[\s\S]*?\*\//g, '');
  const pattern = /panneau(Anime|Film|Scan|Visual)\s*\(\s*(["'])(.*?)\2\s*,\s*(["'])(.*?)\4\s*\)/gi;
  const results = [];
  for (const match of scriptText.matchAll(pattern)) {
    const sourceType = match[1].toLowerCase();
    const name = decodeHtml(match[3]);
    const sourceUrl = absoluteUrl(match[5], pageUrl);
    if (!name || !sourceUrl || name.toLowerCase() === 'nom') continue;
    results.push({
      name,
      kind: sourceType === 'film' ? 'film' : sourceType === 'scan' ? 'scan' : sourceType === 'visual' ? 'webtoon' : 'anime',
      sourceUrl
    });
  }
  const unique = new Map();
  for (const item of results) unique.set(`${item.kind}:${item.sourceUrl}`, item);
  return [...unique.values()];
};

const extractChapters = (html, pageUrl) => {
  const chapters = [];
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attributes = match[1];
    const title = decodeHtml(match[2].replace(/<[^>]*>/g, ''));
    const href = absoluteUrl(extractAttribute(attributes, 'href'), pageUrl);
    if (!title || !href || !/(?:chap(?:itre|ter)?|tome|volume)\s*[\d.]+/i.test(`${title} ${href}`)) continue;
    try {
      safeAnimeSamaUrl(href);
    } catch {
      continue;
    }
    chapters.push({ name: title.slice(0, 120), url: href });
  }
  return [...new Map(chapters.map((chapter) => [chapter.url, chapter])).values()].slice(0, 500);
};

const extractReaderImages = (html, pageUrl) => {
  const ignored = /(?:logo|icon|avatar|banner|advert|pub|sprite|flag)/i;
  const images = [];
  for (const match of html.matchAll(/<img\b([^>]*)>/gi)) {
    const attrs = match[1];
    const candidate = extractAttribute(attrs, 'data-src')
      || extractAttribute(attrs, 'data-lazy-src')
      || extractAttribute(attrs, 'data-original')
      || extractAttribute(attrs, 'src');
    const alt = extractAttribute(attrs, 'alt');
    if (!candidate || ignored.test(`${candidate} ${alt}`)) continue;
    try {
      const image = new URL(candidate, pageUrl);
      if (!['http:', 'https:'].includes(image.protocol)) continue;
      images.push(image.href);
    } catch {
      continue;
    }
  }
  return [...new Set(images)].slice(0, 1000);
};

const scanChapterLabels = (html, total) => {
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((match) => match[1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, ''))
    .join('\n');
  const calls = /\b(resetListe|creerListe|newSPF|newSP|finirListe)\s*\(([^)]*)\)/gi;
  const labels = [];
  let specialCount = 0;

  for (const match of scripts.matchAll(calls)) {
    const operation = match[1].toLowerCase();
    const args = match[2].split(',').map((arg) => arg.trim().replace(/^['"]|['"]$/g, ''));
    const first = Number(args[0]?.replace(',', '.'));

    if (operation === 'resetliste') {
      labels.length = 0;
      specialCount = 0;
    } else if (operation === 'creerliste') {
      const last = Number(args[1]?.replace(',', '.'));
      if (!Number.isInteger(first) || !Number.isInteger(last)) continue;
      for (let value = first; value <= last && labels.length < total; value += 1) {
        labels.push(`Chapitre ${value}`);
      }
    } else if (operation === 'newsp' || operation === 'newspf') {
      const label = decodeHtml(args[0] || '');
      if (label) {
        labels.push(operation === 'newsp' ? `Chapitre ${label}` : label);
        specialCount += 1;
      }
    } else if (operation === 'finirliste' && Number.isInteger(first)) {
      const last = Math.max(0, total - specialCount);
      for (let value = first; value <= last && labels.length < total; value += 1) {
        labels.push(`Chapitre ${value}`);
      }
    }
  }

  if (!labels.length) {
    return Array.from({ length: total }, (_, index) => `Chapitre ${index + 1}`);
  }
  return labels.slice(0, total);
};

const getScanChapterInfo = async (sourceUrl) => {
  const safeUrl = safeAnimeSamaUrl(sourceUrl);
  const page = await fetchText(safeUrl);
  const title = extractTagText(page.text, [
    /<[^>]+\bid=['"]titreOeuvre['"][^>]*>([\s\S]*?)<\/[^>]+>/i,
    /<h1\b[^>]*>([\s\S]*?)<\/h1>/i
  ]);
  if (!title) throw new Error('Le titre du lecteur de scan est introuvable.');

  const countsUrl = new URL('/s2/scans/get_nb_chap_et_img.php', ANIME_SAMA_BASE_URL);
  countsUrl.searchParams.set('oeuvre', title);
  const countsResponse = await fetchText(countsUrl.href, page.url);
  let counts;
  try {
    counts = JSON.parse(countsResponse.text);
  } catch {
    throw new Error('La liste des chapitres source est illisible.');
  }
  if (!counts || typeof counts !== 'object' || Array.isArray(counts)) {
    throw new Error('La liste des chapitres source est invalide.');
  }

  const total = Object.keys(counts).length;
  const labels = scanChapterLabels(page.text, total);
  const chapters = labels.map((name, index) => ({
    id: `scan-${slugify(title)}-${index + 1}`,
    name,
    url: page.url,
    sequence: index + 1,
    pageCount: Number(counts[String(index + 1)]) || 0
  })).filter((chapter) => chapter.pageCount > 0);

  return { title, counts, chapters };
};

const getAnimeSamaScanChapter = async (sourceUrl, sequenceValue) => {
  const sequence = Number(sequenceValue);
  if (!Number.isInteger(sequence) || sequence < 1 || sequence > 1000) {
    throw new Error('Le numéro du chapitre est invalide.');
  }
  const { title, counts, chapters } = await getScanChapterInfo(sourceUrl);
  const pageCount = Number(counts[String(sequence)]);
  if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > 1000) {
    throw new Error('Ce chapitre ne contient aucune page disponible.');
  }
  const pages = Array.from({ length: pageCount }, (_, index) => {
    const path = `/s2/scans/${encodeURIComponent(title)}/${sequence}/${index + 1}.jpg`;
    return absoluteUrl(path);
  });
  return {
    name: `${title} · ${chapters.find((chapter) => chapter.sequence === sequence)?.name || `Chapitre ${sequence}`}`,
    pages
  };
};

const extractMeta = (html, property) => {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = html.match(new RegExp(`<meta\\b(?=[^>]*(?:property|name)=['"]${escaped}['"])[^>]*content=['"]([^'"]*)['"][^>]*>`, 'i'))
    || html.match(new RegExp(`<meta\\b(?=[^>]*content=['"]([^'"]*)['"])[^>]*(?:property|name)=['"]${escaped}['"][^>]*>`, 'i'));
  return decodeHtml(match?.[1] || '');
};

async function getEpisodesForVersion(seasonUrl, versionName) {
  const base = seasonUrl.replace(/\/(?:vostfr|vf)\/?$/i, '').replace(/\/+$/, '');
  const version = versionName.toLowerCase() === 'vf' ? 'vf' : 'vostfr';
  const page = await fetchText(safeAnimeSamaUrl(`${base}/${version}`));
  const sourceMatch = page.text.match(/<script\b(?=[^>]*src=['"][^'"]*episodes\.js[^'"]*['"])[^>]*src=['"]([^'"]+)['"][^>]*>/i)
    || page.text.match(/<script\b[^>]*src=['"]([^'"]*episodes\.js[^'"]*)['"][^>]*>/i);
  if (!sourceMatch) {
    return {
      name: versionName,
      readers: [{ name: 'Lecteur Anime-Sama', episodes: [], available: false }]
    };
  }

  const scriptUrl = safeAnimeSamaUrl(absoluteUrl(sourceMatch[1], page.url));
  const js = (await fetchText(scriptUrl, page.url)).text;
  const arrays = [...js.matchAll(/var\s+(eps\w+)\s*=\s*\[([\s\S]*?)\]\s*;/gi)];
  const readers = arrays.map((match, index) => {
    const episodes = [...match[2].matchAll(/['"](https:\/\/[^'"]+)['"]/g)].map((episode) => episode[1].trim());
    return {
      name: `Lecteur ${String(match[1]).replace(/^eps/i, '') || index + 1}`,
      episodes,
      available: episodes.length > 0
    };
  });
  if (!readers.length) readers.push({ name: 'Lecteur Anime-Sama', episodes: [], available: false });
  return { name: versionName, readers };
}

const extractVideoSources = (html, pageUrl) => {
  const sources = [];
  const add = (attributes, fallbackName, candidateName = 'src') => {
    const candidate = extractAttribute(attributes, candidateName)
      || extractAttribute(attributes, 'data-src')
      || extractAttribute(attributes, 'data-lazy-src');
    if (!candidate) return;
    try {
      const url = new URL(candidate, pageUrl);
      if (url.protocol !== 'https:' || !url.hostname.includes('.') || url.hostname === 'localhost') return;
      sources.push({
        name: extractAttribute(attributes, 'title') || extractAttribute(attributes, 'data-title') || fallbackName,
        url: url.href
      });
    } catch {
      // Ignore malformed or non-web player URLs.
    }
  };

  for (const match of html.matchAll(/<iframe\b([^>]*)>/gi)) add(match[1], `Lecteur ${sources.length + 1}`);
  for (const match of html.matchAll(/<video\b([^>]*)>/gi)) add(match[1], `Vidéo ${sources.length + 1}`);
  for (const match of html.matchAll(/<source\b([^>]*)>/gi)) add(match[1], `Vidéo ${sources.length + 1}`);
  return [...new Map(sources.map((source) => [source.url, source])).values()].slice(0, 12);
};

async function getAnimeSamaEpisode(sourceUrl) {
  const page = await fetchText(safeAnimeSamaUrl(sourceUrl));
  return {
    name: extractTagText(page.text, [/<h1\b[^>]*>([\s\S]*?)<\/h1>/i, /<title\b[^>]*>([\s\S]*?)<\/title>/i]) || 'Épisode',
    streams: extractVideoSources(page.text, page.url)
  };
}

const withConcurrency = async (items, concurrency, callback) => {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await callback(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
};

export async function getAnimeSamaWork(sourceUrl, forceRefresh = false) {
  const safeUrl = safeAnimeSamaUrl(sourceUrl);
  const cached = workCache.get(safeUrl);
  if (!forceRefresh && cached && Date.now() - cached.timestamp < WORK_CACHE_TTL_MS) return cached.data;

  const page = await fetchText(safeUrl);
  const title = extractTagText(page.text, [/<h1\b[^>]*>([\s\S]*?)<\/h1>/i, /<title\b[^>]*>([\s\S]*?)<\/title>/i]);
  const description = extractMeta(page.text, 'description') || extractMeta(page.text, 'og:description');
  const poster = imageUrl(extractMeta(page.text, 'og:image'), page.url);
  const panels = extractPanelEntries(page.text, page.url).slice(0, 30);
  const chapters = extractChapters(page.text, page.url);
  const scanChapters = await withConcurrency(panels.filter((panel) => ['scan', 'webtoon'].includes(panel.kind)), 3, async (panel) => {
    const scan = await getScanChapterInfo(panel.sourceUrl);
    return scan.chapters;
  });
  const typeMatch = page.text.match(/as-badge-(anime|film|scan|webtoon)/i);
  const kind = typeMatch?.[1]?.toLowerCase() || 'anime';
  const seasons = await withConcurrency(panels, 4, async (panel, index) => {
    if (!['anime', 'film'].includes(panel.kind)) {
      return { id: `source-${slugify(panel.name)}-${index + 1}`, name: panel.name, kind: panel.kind, sourceUrl: panel.sourceUrl, versions: [] };
    }
    const versions = await withConcurrency(['VOSTFR', 'VF'], 2, async (versionName) => {
      try {
        return await getEpisodesForVersion(panel.sourceUrl, versionName);
      } catch (error) {
        return {
          name: versionName,
          readers: [{ name: 'Lecteur Anime-Sama', episodes: [], available: false }],
          error: error.message
        };
      }
    });
    return {
      id: `source-${slugify(panel.name)}-${index + 1}`,
      name: panel.name,
      kind: panel.kind,
      sourceUrl: panel.sourceUrl,
      versions
    };
  });

  const data = {
    id: `anime-sama-${slugify(title || safeUrl)}`,
    name: title || panels[0]?.name || 'Œuvre Anime-Sama',
    kind,
    sourceUrl: page.url,
    poster,
    description,
    genres: extractGenres(page.text),
    updatedAt: new Date().toISOString(),
    seasons,
    chapters: [...chapters, ...scanChapters.flat()]
  };
  workCache.set(safeUrl, { timestamp: Date.now(), data });
  return data;
}

const sendJson = (response, status, payload) => {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-API-Key');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  response.end(JSON.stringify(payload));
};

const routeRequest = async (request, response) => {
  const url = new URL(request.url || '/', 'http://localhost');
  if (url.pathname === '/api/anime-sama/catalogue' && request.method === 'GET') {
    const forceRefresh = url.searchParams.get('refresh') === 'true';
    if (forceRefresh && !allowForcedRefresh('catalogue')) {
      sendJson(response, 429, { error: 'Une actualisation récente est déjà en cours. Réessayez dans quelques secondes.' });
      return true;
    }
    const catalogue = await getAnimeSamaCatalogue(forceRefresh);
    const query = (url.searchParams.get('q') || '').trim().toLocaleLowerCase();
    const kind = url.searchParams.get('kind');
    const filtered = catalogue.items.filter((item) =>
      (!query || item.name.toLocaleLowerCase().includes(query)) &&
      (!kind || item.kind === kind)
    );
    sendJson(response, 200, { ...catalogue, count: filtered.length, items: filtered });
    return true;
  }
  if (url.pathname === '/api/anime-sama/planning' && request.method === 'GET') {
    const forceRefresh = url.searchParams.get('refresh') === 'true';
    if (forceRefresh && !allowForcedRefresh('planning')) {
      sendJson(response, 429, { error: 'Une actualisation récente est déjà en cours. Réessayez dans quelques secondes.' });
      return true;
    }
    const planning = await getAnimeSamaPlanning(forceRefresh);
    sendJson(response, 200, planning);
    return true;
  }
  if (url.pathname === '/api/anime-sama/work' && request.method === 'GET') {
    const sourceUrl = url.searchParams.get('url');
    if (!sourceUrl) {
      sendJson(response, 400, { error: 'Le paramètre url est obligatoire.' });
      return true;
    }
    const forceRefresh = url.searchParams.get('refresh') === 'true';
    if (forceRefresh && !allowForcedRefresh('work')) {
      sendJson(response, 429, { error: 'Une actualisation récente est déjà en cours. Réessayez dans quelques secondes.' });
      return true;
    }
    const work = await getAnimeSamaWork(sourceUrl, forceRefresh);
    sendJson(response, 200, work);
    return true;
  }
  if (url.pathname === '/api/anime-sama/chapter' && request.method === 'GET') {
    const sourceUrl = url.searchParams.get('url');
    if (!sourceUrl) {
      sendJson(response, 400, { error: 'Le paramètre url est obligatoire.' });
      return true;
    }
    const sequence = url.searchParams.get('sequence');
    if (sequence && /\/scan\/(?:vf|vostfr|va)(?:\/|$)/i.test(new URL(safeAnimeSamaUrl(sourceUrl)).pathname)) {
      const chapter = await getAnimeSamaScanChapter(sourceUrl, sequence);
      sendJson(response, 200, chapter);
      return true;
    }
    const page = await fetchText(safeAnimeSamaUrl(sourceUrl));
    const title = extractTagText(page.text, [/<h1\b[^>]*>([\s\S]*?)<\/h1>/i, /<title\b[^>]*>([\s\S]*?)<\/title>/i]);
    const pages = extractReaderImages(page.text, page.url);
    if (!pages.length) {
      sendJson(response, 404, { error: 'Aucune page de lecture détectée sur cette source.' });
      return true;
    }
    sendJson(response, 200, { name: title || 'Chapitre', pages });
    return true;
  }
  if (url.pathname === '/api/anime-sama/episode' && request.method === 'GET') {
    const sourceUrl = url.searchParams.get('url');
    if (!sourceUrl) {
      sendJson(response, 400, { error: 'Le paramètre url est obligatoire.' });
      return true;
    }
    const episode = await getAnimeSamaEpisode(sourceUrl);
    if (!episode.streams.length) {
      sendJson(response, 404, { error: 'Aucun lecteur vidéo intégrable n’a été détecté pour cet épisode.' });
      return true;
    }
    sendJson(response, 200, episode);
    return true;
  }
  return false;
};

export async function handleAnimeSamaRequest(request, response) {
  try {
    return await routeRequest(request, response);
  } catch (error) {
    console.error('[anime-sama-api]', error);
    if (!response.headersSent) sendJson(response, 502, { error: 'La source Anime-Sama est momentanément indisponible.', detail: error.message });
    return true;
  }
}

export function animeSamaApiPlugin() {
  const attach = (server) => {
    server.middlewares.use((request, response, next) => {
      handleAnimeSamaRequest(request, response)
        .then(async (handled) => {
          if (handled) return;
          const { handleApiRequest } = await import('./api.js');
          const apiHandled = await handleApiRequest(request, response);
          if (!apiHandled) next();
        })
        .catch((error) => {
          console.error('[api]', error);
          if (!response.headersSent) sendJson(response, 500, { error: 'Erreur interne de l’API.' });
        });
    });
  };
  return {
    name: 'mozilanim-anime-sama-api',
    configureServer: attach,
    configurePreviewServer: attach
  };
}
