# Cumbre — plan de construcción

App personal de productividad para Victor: agenda del día, tareas por área,
notas rápidas y rutinas, con deadlines de Canvas y eventos de Google Calendar
sincronizados automáticamente.

Ya existe una versión funcionando como artifact de Claude
(`reference/cumbre.html`). Este proyecto la reconstruye como app propia,
desplegada, con integraciones reales en vez de importar `.ics` a mano.

---

## 0. Antes de escribir código

Este plan fija la arquitectura, no las versiones. Confirma al empezar:

- `npx create-next-app@latest` → anota qué versión de Next instaló
- Límites vigentes del plan gratis de Supabase y del plan Hobby de Vercel
- La forma exacta de `signInWithOAuth` en los docs de Supabase Auth de hoy
  (el nombre de `provider_token` / `provider_refresh_token` en la sesión es
  lo único de este plan que no quedó verificado contra la documentación)

No pines versiones a mano. Usa `@latest` y deja que el lockfile mande.

---

## 1. Stack

| Pieza | Elección | Por qué |
|---|---|---|
| Framework | Next.js (App Router, TypeScript) | Los route handlers guardan los secretos del lado del servidor; Vercel lo despliega con un push |
| Base de datos | Supabase (Postgres + RLS) | Capa gratis, RLS resuelve la seguridad sin escribir middleware |
| Auth | Supabase Auth, provider Google | Hace doble trabajo: te loguea **y** entrega el token de Calendar. Una integración, no dos |
| Hosting | Vercel | Deploy por push; Vercel Cron para la sincronización diaria |
| Estilos | CSS propio con custom properties | Ya está resuelto en `reference/cumbre.html` — cópialo, no metas Tailwind |

**No** agregues: ORM (usa el cliente de Supabase), librería de estado
(Server Components + `useState`), librería de componentes, ni una librería de
fechas pesada (las utilidades de `reference/cumbre.html` bastan).

---

## 2. Fases

Cada fase termina desplegada y usable. No empieces la siguiente hasta que la
anterior esté en producción y probada desde el teléfono.

### Fase 1 — La app sin integraciones

Objetivo: paridad con `reference/cumbre.html`, pero con Postgres y login.

- `create-next-app`, proyecto en Supabase, `supabase/schema.sql` aplicado
- Login con Google (sin scopes de Calendar todavía — sólo identidad)
- Vistas: Hoy, Tareas, Semana, Notas, Rutinas, Ajustes
- Captura rápida con el parser de `reference/cumbre.html` (`parseInput`) —
  portarlo tal cual, ya maneja `#área`, `!prioridad`, fechas en español,
  horas y duraciones
- Importar `.ics` a mano (el parser también está en el archivo de
  referencia) — sirve de respaldo cuando una API falle
- Deploy a Vercel, probar en el celular

**Listo cuando:** puedes crear una tarea en la laptop y verla en el teléfono.

### Fase 2 — Canvas

Objetivo: los deadlines de SFU entran solos.

- Token personal: Canvas → Account → Settings → **+ New Access Token**.
  Va en `.env.local` y en las variables de entorno de Vercel. Nunca al repo.
- Route handler `POST /api/sync/canvas` (server-only; el token no puede tocar
  el navegador y además Canvas bloquea CORS)
- Endpoint: `GET https://canvas.sfu.ca/api/v1/planner/items`
  con `start_date`, `end_date`, `per_page=100`
  y header `Authorization: Bearer <token>`
- Paginación: sigue el header `Link` con `rel="next"` hasta que no haya
- Nombres de cursos para mapear a áreas:
  `GET /api/v1/users/self/favorites/courses`
- Mapeo a `tasks`:
  - `plannable.title` → `title`
  - `plannable_date` → `due_date` / `due_time`
  - `course_id` → `area` (vía la tabla de cursos)
  - filtra `plannable_type` a `assignment`, `quiz`, `discussion_topic`
  - `submissions.submitted` → ignora lo ya entregado
- Idempotencia: `external_id = 'canvas:' || plannable_type || ':' || plannable_id`,
  con `UNIQUE (user_id, source, external_id)` y `ON CONFLICT DO UPDATE`
- Regla dura: **nunca sobrescribas `done`, `priority` ni `area` si ya los
  tocaste a mano.** Un sync que desmarca tareas hechas mata la confianza en la
  app. Para eso está `user_edited_at`: si tiene valor, el sync sólo actualiza
  título y fecha.

**Listo cuando:** borras un deadline de Canvas de la tabla, corres el sync y
vuelve con los mismos datos, sin duplicados.

### Fase 3 — Google Calendar

Objetivo: clases y compromisos sin exportar nada.

- Google Cloud Console: proyecto nuevo → habilita **Google Calendar API** →
  pantalla de consentimiento OAuth en modo **Testing** con tu propio correo
  como test user. En Testing no necesitas la verificación de Google, que es
  el trámite que hace que la gente abandone esto a medio camino.
- Scope: `https://www.googleapis.com/auth/calendar.readonly` (sólo lectura;
  `calendar.events.readonly` también sirve si quieres acotar más)
- En Supabase Auth, `signInWithOAuth` con ese scope, `access_type=offline` y
  `prompt=consent` para recibir refresh token
- Endpoint:
  `GET https://www.googleapis.com/calendar/v3/calendars/primary/events`
  con `timeMin`, `timeMax`, `singleEvents=true`, `orderBy=startTime`
- `singleEvents=true` expande los eventos recurrentes por ti — esto elimina
  el expansor de `RRULE` que hoy vive en el archivo de referencia
- Idempotencia: `external_id = 'gcal:' || event.id`

**Listo cuando:** tus clases del semestre aparecen en la vista Semana sin que
hayas subido un archivo.

### Fase 4 — Que trabaje sola

- Vercel Cron → `GET /api/sync` diario a las 6:00 hora de Vancouver.
  Protégelo comparando el header `Authorization` contra `CRON_SECRET` y
  respondiendo 401 si no cuadra; si no, cualquiera dispara tus syncs.
- Web Push para recordatorios (`web-push` + service worker). Primero
  pregúntate si de verdad los quieres — una app de productividad que notifica
  de más se silencia y se muere.
- Botón de "Planear mi día": misma idea que el artifact, pero llamando a la
  API de Claude desde un route handler con la key en el servidor.

---

## 3. Modelo de datos

Ver `supabase/schema.sql`. Resumen:

- `profiles` — áreas, horario visible, zona horaria
- `tasks` — título, área, fecha/hora, estimado, prioridad, hecho, origen
- `events` — calendario (Canvas o Google), con `external_id` único
- `notes` — captura rápida, fijables
- `habits` + `habit_log` — rutinas y marcas por día
- `blocks` — bloques de tiempo del día
- `sync_state` — última sincronización por fuente

`schema.sql` está probado contra Postgres 16: corre dos veces seguidas sin
error, el trigger crea el perfil al registrarse, el upsert de sync deja una
sola fila, y RLS efectivamente esconde las filas de otro usuario y rechaza
escribir en ellas.

Decisiones que importan:

- **RLS activo en todas las tablas**, política `auth.uid() = user_id`. Sin
  esto, cualquiera con la anon key lee tus tareas.
- `UNIQUE (user_id, source, external_id)` es lo que hace que sincronizar dos
  veces no duplique nada. El upsert va así:
  `on conflict (user_id, source, external_id) do update set ...`.
  El índice es completo, no parcial, justamente para que esa línea funcione
  (un índice parcial obliga a repetir el `where` dentro del `ON CONFLICT` y
  falla en silencio si se te olvida).
- Horas guardadas como `timestamptz`; fechas sueltas (un deadline sin hora)
  como `date`. No mezcles.
- `user_edited_at` en `tasks` protege tus cambios de los syncs.

---

## 4. Secretos

| Variable | Dónde vive | Qué es |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | público | ok que se vea |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | público | seguro **sólo** con RLS bien puesta |
| `SUPABASE_SERVICE_ROLE_KEY` | servidor | salta RLS — jamás en el cliente |
| `CANVAS_BASE_URL` | servidor | `https://canvas.sfu.ca/api/v1` |
| `CANVAS_TOKEN` | servidor | tu token personal de Canvas |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Supabase Auth | del Cloud Console |
| `CRON_SECRET` | servidor | protege `/api/sync` |
| `ANTHROPIC_API_KEY` | servidor | sólo si haces la fase 4 |

`.env.local` en `.gitignore` desde el primer commit. Si un token se te va al
repo, revócalo en Canvas y genera otro — no basta con borrar el commit.

---

## 5. Lo que no vale la pena

- Soporte multiusuario. Es tu app. Un `user_id` y ya.
- Tests unitarios de la UI. Sí vale probar el parser de captura rápida y el
  mapeo de Canvas — ahí es donde de verdad se rompe.
- App nativa. Agregar a pantalla de inicio desde el navegador es suficiente.
- Modo offline. Complica todo y casi nunca lo vas a necesitar.

---

## Fuentes

- [Canvas LMS Planner API](https://canvas.instructure.com/doc/api/planner.html)
- [Canvas LMS Assignments API](https://www.canvas.instructure.com/doc/api/assignments.html)
- [Google Calendar API — scopes de OAuth](https://developers.google.com/workspace/calendar/api/auth)
- [Google Calendar API — Events: list](https://developers.google.com/workspace/calendar/api/v3/reference/events/list)
- [SFU Canvas](https://canvas.sfu.ca/) · [guía de configuración personal](https://www.sfu.ca/canvas/student-guide/getting-started/personal-settings.html)
