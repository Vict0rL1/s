# TaskFlow

App personal de productividad de Victor: agenda del día, tareas por área, notas
rápidas y rutinas. Un solo usuario. Next.js + Supabase, desplegada en Vercel.

**Estado: fases 1 y 2 construidas.** La app completa con Postgres y login, más
el sync de Canvas. Falta conectarla a tu proyecto de Supabase y desplegarla —
los pasos están abajo.

- `PLAN.md` — el plan completo: stack, las 4 fases, Canvas y Google Calendar
- `CLAUDE.md` — las reglas del proyecto
- `reference/cumbre.html` — el artifact original (se llamaba Cumbre), de donde
  salieron la UI y los parsers. Conserva su nombre a propósito: es la foto de
  la versión publicada, y sus datos viven bajo la clave `cumbre.v1`.

---

## Ponerla a andar

Necesitas una cuenta de **Supabase** y una de **Vercel**, ambas gratis. Google
Cloud Console recién en la fase 3.

### 1. Base de datos

1. Crea un proyecto en [supabase.com](https://supabase.com).
2. Abre el **SQL Editor**, pega todo `supabase/schema.sql` y córrelo. Es
   idempotente: si lo corres dos veces no rompe nada.
3. En **Project Settings → API** copia la *Project URL* y la *anon public key*.

### 2. Login con Google

1. En Supabase, **Authentication → Providers → Google**, actívalo y pega el
   Client ID y el Client Secret del Google Cloud Console.
2. En **Authentication → URL Configuration**, agrega a *Redirect URLs*:
   - `http://localhost:3000/auth/callback`
   - `https://TU-APP.vercel.app/auth/callback`

En la fase 1 el login sólo pide identidad. Los scopes de Calendar entran en la
fase 3, en `components/GoogleButton.tsx` (hay un comentario marcando el lugar).

### 3. Variables de entorno

```bash
cp .env.example .env.local
```

Llena `NEXT_PUBLIC_SUPABASE_URL` y `NEXT_PUBLIC_SUPABASE_ANON_KEY`. Las demás
son de fases posteriores y pueden quedarse vacías.

`.env.local` está en `.gitignore` desde el primer commit y nunca se commitea.

### 4. Canvas (fase 2)

Opcional para arrancar; sin esto la app funciona, sólo que los deadlines los
capturas a mano o los importas por `.ics`.

1. En Canvas: **Account → Settings → + New Access Token**. Ponle fecha de
   expiración y copia el token — sólo se muestra una vez.
2. En `.env.local`:

   ```
   CANVAS_BASE_URL=https://canvas.sfu.ca/api/v1
   CANVAS_TOKEN=el-token-que-acabas-de-generar
   ```

3. Lo mismo en las variables de entorno de Vercel.
4. En la app, **Ajustes → Canvas → Sincronizar ahora**.

El token vive sólo en el servidor: el sync es un route handler porque el token
no puede tocar el navegador, y porque Canvas bloquea CORS de todos modos. Si se
te filtra, revócalo en Canvas y genera otro — borrar el commit no basta.

### 5. Correr

```bash
npm install
npm run dev
```

Si abres <http://localhost:3000> sin configurar nada, la app te manda al login y
te muestra este mismo instructivo en vez de un error.

### 6. Desplegar

Importa el repo en Vercel. Como el proyecto vive en una subcarpeta, en la
configuración del proyecto pon **Root Directory: `taskflow`**. Carga las dos
variables `NEXT_PUBLIC_*` en *Environment Variables* y agrega la URL de
`/auth/callback` de tu dominio a las Redirect URLs de Supabase.

**Fase 1 lista cuando:** creas una tarea en la laptop y la ves en el teléfono.

---

## Comandos

| Comando | Qué hace |
|---|---|
| `npm run dev` | servidor de desarrollo |
| `npm run build` | build de producción (incluye el chequeo de tipos) |
| `npm run test` | los tests del parser y del mapeo de Canvas |
| `npm run typecheck` | sólo TypeScript |
| `npm run lint` | ESLint |

---

## Cómo está armado

```
app/
  (app)/             las seis vistas, con el riel y la captura rápida
    hoy/ tareas/ semana/ notas/ rutinas/ ajustes/
  api/sync/canvas/   route handler del sync de Canvas (POST)
  auth/callback/     canje del código de OAuth por la sesión
  auth/signout/      cerrar sesión
  login/             entrar con Google, o el instructivo si falta configurar
  actions.ts         Server Actions — todo lo que escribe en la base
  globals.css        tokens de color portados del reference
components/          piezas de UI; las de cliente están marcadas "use client"
lib/
  date.ts            fechas y zonas horarias
  parse.ts           captura rápida — portado del reference
  ics.ts             importador .ics de respaldo
  canvas.ts          Canvas: paginación y mapeo a tareas (puro, testeado)
  canvas-sync.ts     el sync en sí: trae de Canvas y escribe en la base
  data.ts            lectura desde Supabase (sólo servidor)
  supabase/          clientes de navegador y de servidor
proxy.ts             refresca la sesión y protege las rutas
supabase/schema.sql  esquema completo, idempotente
tests/               tests del parser
```

Las vistas son Server Components que leen de Supabase; escribir pasa siempre por
un Server Action. No hay librería de estado ni de componentes, y el CSS es el del
reference con sus custom properties.

---

## Decisiones que vale la pena conocer

**Nada de esto lo decide el navegador.** Todas las fechas se calculan en la zona
del perfil (`profiles.timezone`, por defecto `America/Vancouver`), nunca en la
del servidor de Vercel, que corre en UTC. `lib/date.ts` hace la aritmética de
fechas en UTC sobre strings `YYYY-MM-DD` para no tropezar con el horario de
verano.

**El sync respeta lo que tocas a mano.** Cada mutación manual pone
`user_edited_at`. El sync de Canvas manda dos `upsert` distintos: uno con las
columnas del sync para sus propias filas, y otro con sólo título y fecha para
las que tú tocaste. Lo que no viaja en el objeto es exactamente lo que Postgres
no toca, así que `done`, `priority`, `area` y `est_minutes` sobreviven intactos.
Hay un test que lo fija.

**`focus_day` en `tasks`.** El "enfoque del día" del reference vivía en las prefs
locales. Aquí es una columna, agregada a `supabase/schema.sql` con un
`alter table ... add column if not exists` para que el archivo siga corriendo dos
veces sin error.

**El importador de `.ics` es idempotente.** El `external_id` sale del UID del
VEVENT, así que reimportar el mismo archivo no duplica. Reimportar con el mismo
nombre de fuente reemplaza los eventos anteriores.

**El parser recibe "hoy" como parámetro.** `parseInput(raw, { areas, today })` no
lee el reloj por su cuenta: así funciona igual en el servidor y se puede probar.

**`proxy.ts`, no `middleware.ts`.** Next 16 renombró la convención. Los docs de
Supabase todavía la llaman middleware, por eso `lib/supabase/middleware.ts`
conserva ese nombre.

**El bloque de notas de Next vive en `AGENTS.md`.** `next dev` lo reescribe solo;
está ahí y no en `CLAUDE.md` para no ensuciar las reglas escritas a mano.

---

## Verificado al construir esto

Lo que `PLAN.md` pedía confirmar antes de escribir código:

- `create-next-app@latest` instaló **Next 16.3.5** (React 19.2.8, App Router,
  Turbopack). Las versiones las manda el lockfile, no hay pines a mano.
- `signInWithOAuth` toma `{ provider, options: { redirectTo, scopes, queryParams,
  skipBrowserRedirect } }`. Para la fase 3, `access_type` y `prompt` van dentro
  de `queryParams`.
- **`provider_token` y `provider_refresh_token` sí existen** en el objeto
  `Session` de `@supabase/auth-js` (ambos `string | null`, opcionales). Era el
  único punto del plan sin verificar contra la documentación; queda confirmado
  contra los tipos del paquete instalado.
- `@supabase/ssr` 0.12.x pide `cookies: { getAll, setAll }`. Los viejos
  `get`/`set`/`remove` están deprecados y provocan cierres de sesión aleatorios.
- `supabase/schema.sql` corre dos veces seguidas sin error sobre Postgres 18, deja
  RLS activa con su política en las ocho tablas, el trigger crea el perfil al
  registrarse, y el upsert de sync deja una sola fila mientras las tareas
  manuales (con `external_id` nulo) conviven sin chocar.

---

## Lo que sigue

- **Fase 3 — Google Calendar.** Scopes de Calendar en el login y lectura de
  eventos con `singleEvents=true`.
- **Fase 4 — Que trabaje sola.** Vercel Cron, Web Push y el botón de "Planear mi
  día" contra la API de Claude.

El detalle de cada una está en `PLAN.md`.
