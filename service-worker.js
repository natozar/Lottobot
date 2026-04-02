// Firebase Cloud Messaging SW
importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey:"AIzaSyAJ5GdmAKuBJQhHcbtn1dgN8Am5n--SJBo",
  authDomain:"lottobot-8d75e.firebaseapp.com",
  projectId:"lottobot-8d75e",
  storageBucket:"lottobot-8d75e.firebasestorage.app",
  messagingSenderId:"764623255861",
  appId:"1:764623255861:web:0e741825f6316f0be3347c"
});

const messaging = firebase.messaging();

// Background push handler
messaging.onBackgroundMessage((payload) => {
  const { title, body } = payload.notification || {};
  const data = payload.data || {};
  self.registration.showNotification(title || 'Lottobot', {
    body: body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    vibrate: [200, 100, 200],
    data: data,
    actions: [{ action: 'open', title: 'Ver Resultado' }]
  });
});

// Notification click → open app with params
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const url = data.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if (client.url.includes('index.html') && 'focus' in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      return clients.openWindow(url);
    })
  );
});

// ══════ CACHE (existing functionality) ══════
const CACHE_NAME = 'lottobot-v45';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap'
];

const API_CACHE = 'lotteries-api-v1';
const API_BASE = 'https://loteriascaixa-api.herokuapp.com/api/';

// Install — cache static assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    })
  );
  self.skipWaiting();
});

// Activate — clean old caches and remove admin from cache
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if(key !== CACHE_NAME && key !== API_CACHE) return caches.delete(key);
          // Also remove admin.html from current cache
          return caches.open(key).then(c => c.delete('/admin.html'));
        })
      );
    })
  );
  self.clients.claim();
});

// Fetch — Cache First for static, Network First for API
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip Firebase/Google SDK requests — let them go through network
  if (url.hostname.includes('googleapis.com') || url.hostname.includes('gstatic.com') || url.hostname.includes('firebaseapp.com') || url.hostname.includes('firebaseio.com')) {
    return;
  }

  // Skip admin pages — always fetch from network
  if (url.pathname.includes('admin') || url.pathname.includes('painel')) {
    return;
  }

  // Network First for API calls (lotofacil, megasena, quina)
  if (url.href.includes(API_BASE)) {
    event.respondWith(
      fetch(request, { signal: AbortSignal.timeout(8000) })
        .then((response) => {
          const clone = response.clone();
          caches.open(API_CACHE).then((cache) => cache.put(request, clone));
          return response;
        })
        .catch(() => {
          return caches.match(request).then((cached) => {
            return cached || new Response(
              JSON.stringify({ offline: true }),
              { headers: { 'Content-Type': 'application/json' } }
            );
          });
        })
    );
    return;
  }

  // HTML pages — Network First (always try fresh, fallback to cache)
  if (request.destination === 'document' || url.pathname === '/' || url.pathname.endsWith('.html')) {
    event.respondWith(
      fetch(request, { signal: AbortSignal.timeout(5000) })
        .then((response) => {
          if (response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => {
          return caches.match(request).then(c => c || caches.match('/index.html'));
        })
    );
    return;
  }

  // Other static assets — Cache First
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        }
        return response;
      });
    }).catch(() => null)
  );
});
