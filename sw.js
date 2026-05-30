/* ══════════════════════════════════════════════
   Service Worker — Administración Peravia
   Cache-first para assets locales.
   Supabase / CDN / fuentes → siempre red.
══════════════════════════════════════════════ */

const CACHE = 'peravia-v1';
const STATIC = ['./', './index.html', './styles.css', './script.js'];

/* ── Instalación: pre-cachear el app shell ─ */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(cache =>
      Promise.allSettled(STATIC.map(url => cache.add(url).catch(() => {})))
    ).then(() => self.skipWaiting())
  );
});

/* ── Activación: limpiar cachés viejos ───── */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* ── Fetch: cache-first para assets propios ─ */
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  const url = event.request.url;

  /* Dejar pasar peticiones externas siempre a red */
  if (
    url.includes('supabase.co') ||
    url.includes('googleapis.com') ||
    url.includes('gstatic.com') ||
    url.includes('jsdelivr.net') ||
    url.includes('emailjs.com') ||
    url.includes('fontawesome') ||
    url.includes('chrome-extension')
  ) return;

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request)
        .then(response => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE).then(cache => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => caches.match('./index.html'));
    })
  );
});
