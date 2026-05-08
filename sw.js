// Callforge Service Worker v2
// Handles offline support, PWA caching, AND share sheet uploads

const CACHE_NAME    = 'callforge-v2';
const SHARE_CACHE   = 'callforge-share';
const STATIC_ASSETS = [
  '/dashboard.html',
  '/index.html',
  '/Tito.png',
  '/og-image.png',
  '/manifest.json',
];

// ── INSTALL ────────────────────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// ── ACTIVATE ───────────────────────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME && key !== SHARE_CACHE)
          .map(key => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// ── FETCH ──────────────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // SHARE SHEET: OS sends POST to /dashboard.html with multipart audio file
  if (url.pathname === '/dashboard.html' && event.request.method === 'POST') {
    // Redirect user to dashboard immediately
    event.respondWith(Response.redirect('/dashboard.html?shared=1', 303));
    // Store the file in background
    event.waitUntil(handleSharedFile(event.request.clone()));
    return;
  }

  // Skip API / external calls
  if (
    url.pathname.startsWith('/api/') ||
    url.hostname.includes('supabase.co') ||
    url.hostname.includes('anthropic.com') ||
    url.hostname.includes('openai.com')
  ) {
    return;
  }

  // Network first, cache fallback
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() =>
        caches.match(event.request).then(
          (cached) => cached || caches.match('/dashboard.html')
        )
      )
  );
});

// ── HANDLE SHARED FILE ─────────────────────────────────────────────────────
async function handleSharedFile(request) {
  try {
    const formData = await request.formData();
    const file = formData.get('recording');

    if (!file || !(file instanceof File)) {
      console.log('[SW] Share received but no audio file found in formData');
      return;
    }

    console.log('[SW] Shared file:', file.name, file.type, file.size + ' bytes');

    // Store in share cache so dashboard can pick it up
    const cache = await caches.open(SHARE_CACHE);
    const fileResponse = new Response(file, {
      headers: {
        'Content-Type':  file.type || 'audio/m4a',
        'X-File-Name':   encodeURIComponent(file.name || 'shared-recording.m4a'),
        'X-File-Size':   file.size.toString(),
        'X-Shared-At':   Date.now().toString(),
      }
    });
    await cache.put('/shared-recording', fileResponse);

    // Notify open windows immediately
    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach(client =>
      client.postMessage({
        type:     'SHARED_FILE_READY',
        fileName: file.name,
        fileSize: file.size,
        fileType: file.type,
      })
    );

    console.log('[SW] File stored, clients notified:', clients.length);
  } catch (err) {
    console.error('[SW] handleSharedFile error:', err);
  }
}

// ── PUSH NOTIFICATIONS ─────────────────────────────────────────────────────
self.addEventListener('push', (event) => {
  if (!event.data) return;
  const data = event.data.json();
  event.waitUntil(
    self.registration.showNotification(data.title || '⚒ Callforge', {
      body:  data.body  || 'Your call has been forged ⚒',
      icon:  '/Tito.png',
      badge: '/Tito.png',
      data:  { url: data.url || '/dashboard.html' },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.openWindow(event.notification.data?.url || '/dashboard.html')
  );
});
