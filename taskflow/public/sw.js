/*
 * Service worker de TaskFlow: recibe los avisos y los muestra, mantiene la
 * suscripción al día cuando el navegador la rota, y sin conexión muestra una
 * página útil en vez del dinosaurio.
 *
 * Lo único que cachea es esa página. Ni las vistas ni los datos: son de tu
 * cuenta, cambian a cada rato, y una agenda vieja mostrada como si fuera la de
 * hoy es peor que decir "sin conexión".
 */

const CACHE = "taskflow-offline-v1";
const OFFLINE = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.add(new Request(OFFLINE, { cache: "reload" }))).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("taskflow-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Sólo las navegaciones (abrir una vista), y sólo si la red falla.
self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") return;
  event.respondWith(fetch(event.request).catch(() => caches.match(OFFLINE)));
});

self.addEventListener("push", (event) => {
  let datos = {};
  try {
    datos = event.data ? event.data.json() : {};
  } catch {
    datos = { title: "TaskFlow", body: event.data ? event.data.text() : "" };
  }

  const titulo = datos.title || "TaskFlow";
  event.waitUntil(
    self.registration.showNotification(titulo, {
      body: datos.body || "",
      // PNG: Chrome en Android no pinta un SVG en la notificación. Sin
      // `badge`: ahí sólo cuenta la transparencia, y un ícono cuadrado opaco
      // sale como un cuadro blanco; el del navegador se ve mejor.
      icon: "/icons/icon-192.png",
      // Un `tag` fijo hace que el aviso de hoy reemplace al de ayer en vez de
      // apilarse. Una app que acumula notificaciones se silencia y se muere.
      tag: "taskflow-diario",
      renotify: false,
      data: { url: datos.url || "/hoy" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const destino = (event.notification.data && event.notification.data.url) || "/hoy";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((ventanas) => {
      // Si la app ya está abierta, se enfoca esa pestaña en vez de abrir otra.
      for (const v of ventanas) {
        if ("focus" in v) {
          v.navigate?.(destino);
          return v.focus();
        }
      }
      return self.clients.openWindow(destino);
    }),
  );
});

/*
 * El navegador puede cambiar la suscripción por su cuenta (caduca, se rota la
 * llave). La vieja empieza a fallar con 410 y, si nadie se entera, los avisos
 * dejan de llegar en silencio. Aquí se vuelve a suscribir y se le avisa al
 * servidor. Si algo falla (sin sesión, sin red), la app lo arregla al abrirse.
 */
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      const vieja = event.oldSubscription || null;
      let nueva = event.newSubscription || null;
      const llave = vieja && vieja.options && vieja.options.applicationServerKey;
      if (!nueva && llave) {
        nueva = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: llave });
      }
      if (!nueva) return;
      const json = nueva.toJSON();
      await fetch("/api/push/subscription", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ endpoint: nueva.endpoint, keys: json.keys, oldEndpoint: vieja ? vieja.endpoint : null }),
      });
    })().catch(() => {}),
  );
});
