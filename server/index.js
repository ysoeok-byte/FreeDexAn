import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleApiRequest } from './api.js';
import { handleAnimeSamaRequest } from './anime-sama-api.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const port = Number(process.env.PORT || 5000);
const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2'
};
const sendFile = async (response, filePath) => {
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw new Error('Not a file');
    response.statusCode = 200;
    response.setHeader('Content-Type', contentTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream');
    response.setHeader('Content-Length', fileStat.size);
    createReadStream(filePath).pipe(response);
  } catch {
    response.statusCode = 404;
    response.end('Not found');
  }
};

const server = createServer(async (request, response) => {
  try {
    if (await handleApiRequest(request, response)) return;
    if (await handleAnimeSamaRequest(request, response)) return;
    const requestPath = decodeURIComponent(new URL(request.url || '/', 'http://localhost').pathname);
    const relativePath = requestPath === '/' ? 'index.html' : requestPath.replace(/^\/+/, '');
    const requestedFile = path.resolve(root, relativePath);
    const safeFile = requestedFile.startsWith(`${root}${path.sep}`) ? requestedFile : path.join(root, 'index.html');
    try {
      const fileStat = await stat(safeFile);
      await sendFile(response, fileStat.isFile() ? safeFile : path.join(root, 'index.html'));
    } catch {
      await sendFile(response, path.join(root, 'index.html'));
    }
  } catch (error) {
    console.error('[server]', error);
    if (!response.headersSent) {
      response.statusCode = 500;
      response.end('Internal server error');
    }
  }
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Mozilanim production server listening on port ${port}`);
});
