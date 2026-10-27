import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

const uploadDirectory = path.resolve(process.cwd(), 'uploads');

const safeId = (value) => /^[a-zA-Z0-9_-]+$/.test(value || '');
const pathsFor = (id) => ({
  part: path.join(uploadDirectory, `${id}.part`),
  file: path.join(uploadDirectory, id),
  meta: path.join(uploadDirectory, `${id}.json`)
});

const sendJson = (response, status, payload) => {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(payload));
};

const readJson = async (request) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
};

const contentRangeStart = (request) => {
  const match = String(request.headers['content-range'] || '').match(/^bytes\s+(\d+)-(\d+)\/(\d+)$/);
  return match ? { start: Number(match[1]), end: Number(match[2]), total: Number(match[3]) } : null;
};

async function handleUpload(request, response, pathname) {
  await fsp.mkdir(uploadDirectory, { recursive: true });
  const parts = pathname.split('/').filter(Boolean);

  if (request.method === 'POST' && parts.length === 3 && parts[1] === 'uploads' && parts[2] === 'init') {
    const body = await readJson(request);
    const id = String(body.id || '');
    if (!safeId(id) || !Number.isFinite(body.size) || body.size < 1) return sendJson(response, 400, { error: 'Upload invalide.' });
    const paths = pathsFor(id);
    if (!fs.existsSync(paths.part) && !fs.existsSync(paths.file)) await fsp.writeFile(paths.part, '');
    await fsp.writeFile(paths.meta, JSON.stringify({ name: body.name || 'video', type: body.type || 'video/mp4', size: body.size }));
    return sendJson(response, 200, { id, uploadedBytes: fs.existsSync(paths.part) ? (await fsp.stat(paths.part)).size : 0 });
  }

  if (!safeId(parts[2])) return sendJson(response, 400, { error: 'Identifiant invalide.' });
  const id = parts[2];
  const paths = pathsFor(id);

  if (request.method === 'PATCH' && parts.length === 3) {
    const range = contentRangeStart(request);
    if (!range) return sendJson(response, 400, { error: 'Content-Range manquant.' });
    const currentSize = fs.existsSync(paths.part) ? (await fsp.stat(paths.part)).size : 0;
    if (currentSize !== range.start) return sendJson(response, 409, { error: 'Décalage d’upload.', uploadedBytes: currentSize });
    await pipeline(request, fs.createWriteStream(paths.part, { flags: 'a' }));
    const uploadedBytes = (await fsp.stat(paths.part)).size;
    return sendJson(response, 200, { id, uploadedBytes });
  }

  if (request.method === 'POST' && parts.length === 4 && parts[3] === 'complete') {
    const body = await readJson(request);
    if (!fs.existsSync(paths.part)) return sendJson(response, 404, { error: 'Upload introuvable.' });
    const size = (await fsp.stat(paths.part)).size;
    if (size !== Number(body.size)) return sendJson(response, 409, { error: 'Taille de fichier incomplète.', uploadedBytes: size });
    await fsp.rename(paths.part, paths.file);
    return sendJson(response, 200, { id, url: `/api/uploads/${id}/file` });
  }

  if (request.method === 'GET' && parts.length === 4 && parts[3] === 'file') {
    if (!fs.existsSync(paths.file)) return sendJson(response, 404, { error: 'Vidéo introuvable.' });
    const meta = fs.existsSync(paths.meta) ? JSON.parse(await fsp.readFile(paths.meta, 'utf8')) : {};
    const stat = await fsp.stat(paths.file);
    response.statusCode = 200;
    response.setHeader('Content-Type', meta.type || 'video/mp4');
    response.setHeader('Content-Length', stat.size);
    response.setHeader('Accept-Ranges', 'bytes');
    return fs.createReadStream(paths.file).pipe(response);
  }

  return sendJson(response, 404, { error: 'Route d’upload introuvable.' });
}

export function uploadApiPlugin() {
  const attach = (server) => {
    server.middlewares.use(async (request, response, next) => {
      const pathname = new URL(request.url || '/', 'http://localhost').pathname;
      if (!pathname.startsWith('/api/uploads')) return next();
      try {
        await handleUpload(request, response, pathname);
      } catch (error) {
        console.error('[upload-api]', error);
        if (!response.headersSent) sendJson(response, 500, { error: 'Erreur pendant l’upload.' });
      }
    });
  };
  return {
    name: 'mozilanim-upload-api',
    configureServer: attach,
    configurePreviewServer: attach
  };
}