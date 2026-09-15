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

## Verla funcionando ahora mismo, sin cuentas

```bash
npm install
npm run demo
```

Abre <http://localhost:3000> y entra con **victor@ejemplo.com** / **contrasena**.

Eso levanta un Supabase de mentira en tu máquina (Postgres de verdad compilado a
WebAssembly, con el esquema real y la RLS activa) y lo siembra con tareas, notas,
rutinas, bloques y clases de ejemplo. No hay que crear ninguna cuenta.

Los datos viven en memoria: cuando cortas el proceso, se van. Es para ver y
probar la app, no para usarla de verdad — para eso están los pasos de abajo.

El código del demo está en `tools/demo/` y la app no importa nada de ahí.

---

## Ponerla a andar de verdad

Necesitas una cuenta de **Supabase**, gratis. Vercel sólo cuando quieras abrirla
desde el teléfono, y Google Cloud Console recién en la fase 3.

**El camino corto para verla funcionando hoy**: pasos 1, 2a, 3 y 5. Son unos ocho
minutos y una sola consola.

### 1. Base de datos

1. Crea un proyecto en [supabase.com](https://supabase.com).
2. Abre el **SQL Editor**, pega todo `supabase/schema.sql` y córrelo. Es
   idempotente: si lo corres dos veces no rompe nada.
3. En **Project Settings → API** copia la *Project URL* y la llave pública. Según
   qué tan reciente sea el panel aparece como *anon public* o como *publishable
   key* (`sb_publishable_…`); las dos sirven para `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
   La que **no** va aquí es la *service role* / *secret key*: esa salta la RLS y
   nunca debe tocar el navegador.

### 2. Login

Hay dos formas de entrar. La de correo no necesita nada más que Supabase; la de
Google hace falta para la fase 3, porque es la que entrega el token de Calendar.

#### 2a. Con correo y contraseña — lo rápido

El proveedor de correo de Supabase ya viene activado, así que no hay nada que
configurar. Sólo un ajuste para no depender del correo de confirmación:

1. **Authentication → Providers → Email** → apaga **Confirm email**.
2. Abre la app, escribe tu correo y una contraseña, y dale a **Crear cuenta**.
   Entras de inmediato.
3. **En cuanto tengas tu cuenta**, vuelve ahí y apaga **Allow new users to sign
   up**. Si no, cualquiera que encuentre la URL puede registrarse. La RLS impide
   que vean tus datos, pero no hay razón para dejar el registro abierto en una
   app de un solo usuario.

Si prefieres dejar **Confirm email** encendido, también funciona: te llega un
correo con un enlace. Supabase limita esos envíos a unos pocos por hora en el
plan gratis, así que para probar es más cómodo apagarlo.

#### 2b. Con Google — para la fase 3

Son dos consolas y hay **dos URLs de redirección distintas**. Confundirlas es el
error clásico, así que lee esto antes de pegar nada.

**En Google Cloud Console** ([console.cloud.google.com](https://console.cloud.google.com)):

1. Proyecto nuevo.
2. **APIs y servicios → Pantalla de consentimiento OAuth** → tipo **Externo**,
   déjala en modo **Testing** y agrégate como *test user* con tu propio correo.
   En Testing no necesitas la verificación de Google, que es el trámite que hace
   que la gente abandone esto a medio camino.
3. **Credenciales → Crear credenciales → ID de cliente de OAuth → Aplicación
   web**.
4. En *URIs de redireccionamiento autorizados* pon **la de Supabase**, no la de
   tu app:

   ```
   https://TU-REF.supabase.co/auth/v1/callback
   ```

   `TU-REF` es el identificador del proyecto, el mismo que sale en
   `NEXT_PUBLIC_SUPABASE_URL`. Quien habla con Google es Supabase, no TaskFlow.
5. Copia el **Client ID** y el **Client Secret**.

**En Supabase:**

6. **Authentication → Providers → Google**: actívalo y pega esos dos valores.
   Van aquí, no en `.env.local`.
7. **Authentication → URL Configuration**: en *Site URL* pon
   `http://localhost:3000` mientras desarrollas, y en *Redirect URLs* agrega
   **las de tu app** (estas sí):
   - `http://localhost:3000/auth/callback`
   - `https://TU-APP.vercel.app/auth/callback`

En resumen: Google apunta a Supabase, y Supabase apunta a TaskFlow.

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
| `npm run demo` | la app con datos de ejemplo, sin cuentas |
| `npm run dev` | servidor de desarrollo (necesita `.env.local`) |
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
tools/demo/          Supabase de mentira para `npm run demo` (sólo desarrollo)
supabase/schema.sql  esquema completo, idempotente
tests/               tests del parser
```

Las vistas son Server Components que leen de Supabase; escribir pasa siempre por
un Server Action. No hay librería de estado ni de componentes, y el CSS es el del
reference con sus custom properties.

---

## Decisiones que vale la pena conocer

**Editar una tarea es volver a escribirla.** Tocas el título y se vuelve un
campo; lo que escribes pasa por el mismo parser de la captura rápida, así que
«Llamar al dentista mañana !alta» arregla el texto, mueve la fecha y sube la
prioridad de una sola pasada. Lo que el parser no encuentra se deja como está,
así que corregir una palabra no te borra el área ni el estimado. No hay un
formulario de edición aparte porque no hace falta.

**En el teléfono, primero lo accionable.** La agenda mide unos 660px que casi
siempre están vacíos, y en una pantalla de 390px enterraba lo que hay que
hacer. Por debajo de 760px el orden se invierte: enfoque, tareas y rutinas
arriba; la agenda, después.

**Un color, un significado.** El sistema del reference usaba el mismo acento
para la marca, para lo urgente, para lo destacado y para los errores — cinco
trabajos, un solo rojo, y por eso todo competía. Ahora `--accent` es sólo la
marca y lo interactivo, y `--danger` aparece únicamente cuando algo va tarde.
En la misma línea, una fecha normal es texto plano: la caja se reserva para lo
atrasado y lo que vence hoy, así el ojo encuentra eso primero.

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
