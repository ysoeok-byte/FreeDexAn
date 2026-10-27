const VIDEO_DB_NAME = 'mozilanim-video-storage';
const VIDEO_STORE_NAME = 'videos';
const CHUNK_SIZE = 1024 * 1024;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

function openVideoDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(VIDEO_DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(VIDEO_STORE_NAME, { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function getVideo(id) {
  return openVideoDb().then((db) => new Promise((resolve, reject) => {
    const request = db.transaction(VIDEO_STORE_NAME, 'readonly').objectStore(VIDEO_STORE_NAME).get(id);
    request.onsuccess = () => {
      db.close();
      resolve(request.result);
    };
    request.onerror = () => {
      db.close();
      reject(request.error);
    };
  }));
}

function updateVideo(id, changes) {
  return openVideoDb().then((db) => new Promise((resolve, reject) => {
    const transaction = db.transaction(VIDEO_STORE_NAME, 'readwrite');
    const store = transaction.objectStore(VIDEO_STORE_NAME);
    const getRequest = store.get(id);
    getRequest.onsuccess = () => store.put({ ...getRequest.result, ...changes });
    transaction.oncomplete = () => {
      db.close();
      resolve();
    };
    transaction.onerror = () => {
      db.close();
      reject(transaction.error);
    };
  }));
}

async function registerRetry() {
  if (self.registration.sync) {
    try {
      await self.registration.sync.register('mozilanim-video-uploads');
    } catch {
      // The next page visit will retry when Background Sync is unavailable.
    }
  }
}

async function uploadVideo(id) {
  const record = await getVideo(id);
  if (!record?.blob || record.uploadStatus === 'complete') return;
  try {
    const initResponse = await fetch('/api/uploads/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, name: record.name, type: record.type, size: record.blob.size })
    });
    if (!initResponse.ok) throw new Error('Initialisation impossible');
    const init = await initResponse.json();
    let offset = Math.max(Number(record.uploadedBytes) || 0, Number(init.uploadedBytes) || 0);
    while (offset < record.blob.size) {
      const end = Math.min(offset + CHUNK_SIZE, record.blob.size);
      const chunk = record.blob.slice(offset, end);
      const response = await fetch(`/api/uploads/${id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': record.type || 'application/octet-stream',
          'Content-Range': `bytes ${offset}-${end - 1}/${record.blob.size}`
        },
        body: chunk
      });
      if (!response.ok) throw new Error('Envoi interrompu');
      const result = await response.json();
      offset = Number(result.uploadedBytes) || end;
      await updateVideo(id, { uploadedBytes: offset, uploadStatus: 'uploading' });
    }
    const completeResponse = await fetch(`/api/uploads/${id}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ size: record.blob.size })
    });
    if (!completeResponse.ok) throw new Error('Finalisation impossible');
    const complete = await completeResponse.json();
    await updateVideo(id, { uploadedBytes: record.blob.size, uploadStatus: 'complete', remoteUrl: complete.url });
  } catch (error) {
    await updateVideo(id, { uploadStatus: 'waiting', uploadError: error.message });
    await registerRetry();
  }
}

async function uploadPending() {
  const db = await openVideoDb();
  const records = await new Promise((resolve, reject) => {
    const request = db.transaction(VIDEO_STORE_NAME, 'readonly').objectStore(VIDEO_STORE_NAME).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  db.close();
  for (const record of records) {
    if (record.uploadStatus !== 'complete') await uploadVideo(record.id);
  }
}

self.addEventListener('message', (event) => {
  if (event.data?.type === 'UPLOAD_VIDEO') event.waitUntil(uploadVideo(event.data.id));
});

self.addEventListener('sync', (event) => {
  if (event.tag === 'mozilanim-video-uploads') event.waitUntil(uploadPending());
});