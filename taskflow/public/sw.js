/*
 * Service worker de TaskFlow. Sólo hace una cosa: recibir el aviso diario y
 * mostrarlo. No cachea nada — la app no es offline-first, y un caché mal hecho
 * es peor que no tenerlo.
 */

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

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
      icon: "/icon.svg",
      badge: "/icon.svg",
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
