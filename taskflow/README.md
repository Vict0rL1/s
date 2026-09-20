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

### 5. Sync automático (fase 4)

Para que Canvas entre solo cada día, sin tocar el botón. Necesita estar
desplegada en Vercel.

1. Genera un secreto: `openssl rand -base64 32`.
2. En las variables de entorno de Vercel:

   ```
   CRON_SECRET=el-secreto-que-acabas-de-generar
   SUPABASE_SERVICE_ROLE_KEY=...   # Supabase → Project Settings → API
   ```

3. `vercel.json` ya trae el horario. Vercel lo levanta solo al desplegar.

`GET /api/sync` compara el header `Authorization` contra `CRON_SECRET` y
responde 401 si no cuadra; sin eso, cualquiera en internet podría disparar tus
syncs. Como corre sin sesión, usa la service role, que **salta la RLS**: por eso
todo lo que hay dentro filtra por `user_id` a mano.

La **service role key nunca debe llegar al navegador**. Vive en
`lib/env.server.ts`, que lleva `server-only`: importarla desde un componente
cliente es un error de build, no un descuido que se descubre en producción.

**Esa ruta es el reloj entero de la app.** Se la puede llamar cada hora sin
miedo, porque cada llamada pregunta "¿qué toca ahora?" y casi siempre la
respuesta es "nada":

- Canvas se sincroniza si la última vez fue hace más de tres horas. Con el cron
  de Vercel solo, eso es una vez al día; con el reloj de GitHub del paso 6, unas
  ocho veces, que es lo que hace que un deadline publicado a mediodía aparezca
  esa misma tarde.
- El aviso se manda si la hora **local** cae en su ventana y no se mandó ya hoy.

Para probarla a mano hay dos atajos, que igual piden el secreto:
`?canvas=1` fuerza el sync aunque acabe de correr, y `?digest=morning` o
`?digest=night` mandan ese aviso al instante, saltándose la ventana y el
registro (si no, sólo se podría probar una vez al día).

```bash
curl -H "Authorization: Bearer $CRON_SECRET" \
  "https://tu-app.vercel.app/api/sync?digest=night"
```

**Sobre la hora.** El cron de Vercel se programa en UTC, así que `0 15 * * *`
son las 8:00 en Vancouver en horario de verano y las 7:00 en invierno. Las dos
caen dentro de la ventana de la mañana, que es lo único que importa: el número
exacto no, porque quien decide es la app mirando tu hora local, no el cron.

### 6. Avisos en el teléfono (fase 4)

Dos avisos al día: el **resumen de la mañana** (lo que vence hoy, lo atrasado y
lo que hay en la agenda) y el de **la noche anterior**, que habla de mañana —
que es cuando todavía puedes hacer algo al respecto. Es push del navegador: no
hace falta instalar nada de una tienda ni usar Firebase. **Sólo funciona sobre
HTTPS**, así que hay que desplegarla primero (en `localhost` también, pero no
desde el teléfono).

1. Genera el par de llaves, una sola vez:

   ```bash
   npx web-push generate-vapid-keys
   ```

2. En las variables de entorno de Vercel:

   ```
   NEXT_PUBLIC_VAPID_PUBLIC_KEY=la-publica
   VAPID_PRIVATE_KEY=la-privada
   VAPID_SUBJECT=mailto:tu@correo.com
   ```

   La pública también llega al navegador — así funciona, no es un descuido. La
   privada nunca sale del servidor.

3. Vuelve a desplegar, abre la app **en el teléfono** y entra a **Ajustes →
   Avisos → Activar**. El navegador te pide permiso una vez.

4. En iPhone hay un paso extra: Safari sólo permite avisos si antes agregaste
   la app a la pantalla de inicio (Compartir → *Agregar a pantalla de inicio*).
   Ábrela desde ahí, no desde Safari.

#### El reloj: por qué hace falta GitHub Actions

Son dos avisos al día y **el plan gratis de Vercel permite un cron**. Dos horas
fijas en UTC tampoco servirían: en noviembre Vancouver pasa de UTC-7 a UTC-8 y
los dos avisos se correrían una hora.

Así que el reloj se separa de la decisión. `.github/workflows/taskflow-clock.yml`
llama a `/api/sync` **cada hora** y la app mira tu hora local y decide. El cron
de Vercel se queda como red de seguridad para la mañana. Como este repositorio
es público, las Actions programadas no cuestan nada.

Para encenderlo, dos secretos del repositorio (**Settings → Secrets and
variables → Actions → New repository secret**). No van en ningún archivo:

```
APP_URL      https://tu-app.vercel.app     (sin barra al final)
CRON_SECRET  el mismo valor que pusiste en Vercel
```

Desde la pestaña **Actions → taskflow clock → Run workflow** se dispara a mano,
y ahí mismo se puede pedir `night` para ver el aviso de la noche sin esperar a
las nueve.

Dos cosas que conviene saber de antemano:

- GitHub **desactiva los workflows programados de un repo público tras 60 días
  sin commits**. Si un día dejan de llegar los avisos, es casi seguro eso:
  Actions → Enable workflow.
- El horario de GitHub es "aproximadamente cada hora", no al minuto. Por eso las
  ventanas de la app son anchas (la mañana va de tu `day_start` a las 12) y por
  eso quien impide el duplicado no es la hora sino la tabla `digest_log`: una
  fila por día y por tipo, y la clave primaria rechaza la segunda.

#### Cuándo NO suena

Si un día no hay nada atrasado, nada que venza y nada en la agenda, **no suena
nada**. Una app que avisa por avisar se silencia y se deja de usar.

El de la noche es más estricto todavía: si mañana no hay nada, no se manda,
aunque hoy hayas dejado cosas sin hacer. Eso ya sale en el aviso de la mañana, y
el mismo texto dos veces al día es justo como se consigue que alguien apague las
notificaciones. Lo pendiente de hoy aparece, pero sólo como cola de un aviso que
ya tenía motivo propio.

Para dejar de recibirlos, el mismo botón en Ajustes. Y si borras el navegador o
revocas el permiso, la suscripción muerta se limpia sola en el siguiente envío.

### 7. Planear el día con Claude (fase 4, opcional y de pago)

Un botón al pie de la agenda que reparte tus tareas pendientes en los ratos que
de verdad tienes libres hoy.

1. Saca una key en [console.anthropic.com](https://console.anthropic.com) →
   **API keys**, y ponla en `.env.local` y en Vercel:

   ```
   ANTHROPIC_API_KEY=sk-ant-...
   ```

2. Sin esa variable **el botón no aparece** y el resto de la app funciona igual.

**Esto cuesta dinero.** Es lo único de TaskFlow que no es gratis: la API de
Anthropic se cobra por uso. Cada plan ronda el centavo de dólar, y la app te
enseña el costo exacto de cada llamada debajo de la propuesta, para que no te
enteres en la factura. Si quieres gastar menos, `PLANNER_MODEL=claude-sonnet-5`
o `claude-haiku-4-5`.

**Propone, no dispone.** La propuesta se ve en pantalla con sus horas; se
agenda sólo si le das a *Agendar*, y entonces se **suma** a lo que ya tenías.
Nunca borra un bloque que pusiste a mano. La versión del artifact sí lo hacía
—reemplazaba el día entero— y ese es justo el tipo de cosa que hace que una app
se deje de usar.

**Los huecos los calcula el servidor, no el modelo.** `lib/planner.ts` resta tus
clases, eventos y bloques del horario visible del perfil y entrega sólo los
ratos libres. Al modelo no se le pide que respete tus compromisos: se le da un
tablero donde pisarlos es imposible. Lo que devuelve se vuelve a validar contra
esos huecos antes de enseñártelo.

#### Partir una tarea en pasos

El botón `⋮⋮` de una fila de Tareas reparte una entrega grande en 3-6 pasos con
fecha propia. Aparece sólo en tareas pendientes que vencen dentro de **3 días o
más**: con menos margen, los pasos se amontonan y el resultado es la misma pared
con más filas.

Reparte **hacia atrás**: el último paso cae al menos un día antes del
vencimiento, y carga más trabajo al principio que al final. Terminar el día de
la entrega es no tener margen para nada.

Los pasos entran como tareas normales **junto a la original**, que no se toca ni
se borra. No hay jerarquía en el esquema y no se inventa una: una columna
`parent_id` obligaría a anidar en todas las vistas, y para cuatro pasos con
fecha eso es más estructura que provecho.

### 8. Correr

```bash
npm install
npm run dev
```

Si abres <http://localhost:3000> sin configurar nada, la app te manda al login y
te muestra este mismo instructivo en vez de un error.

### 9. Desplegar

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
  api/export/        baja todos tus datos en JSON (GET)
  api/sync/          el reloj: sync de Canvas y avisos, con CRON_SECRET (GET)
  api/plan/          propone un plan para hoy; no escribe nada (POST)
  api/breakdown/     propone los pasos de una tarea; no escribe nada (POST)
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
  push.ts            arma los dos avisos del día y los manda (sólo servidor)
  planner.ts         huecos libres del día + el plan con Claude (sólo servidor)
  breakdown.ts       parte una tarea grande en pasos con fecha (sólo servidor)
  data.ts            lectura desde Supabase (sólo servidor)
  supabase/          clientes de navegador, de servidor y de service role
public/sw.js         service worker: recibe el aviso y abre /hoy al tocarlo
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

**Una API nunca se redirige al login.** El proxy manda al login las páginas sin
sesión, pero deja pasar `/api/*`, donde cada handler comprueba por su cuenta y
responde 401 en JSON. Antes no: `/api/sync` recibía un 307 hacia `/login`, y
como el cron de Vercel no manda cookies, el sync diario no habría corrido nunca
— sin un solo error a la vista. Salió al probar el endpoint, no al leerlo.

**La semana vive en la URL.** `/semana?w=2` es dentro de dos semanas, igual que
el filtro de área en Tareas. Se recarga, se comparte y se puede marcar. El
desplazamiento se limita a un año en cada sentido y los valores raros caen a la
semana actual.

**Hay respaldo, no hay «borrar todo».** `GET /api/export` baja todas tus filas
en JSON. Lo que no porté del artifact es el botón de borrar todo: ahí hacía
falta porque los datos vivían en `localStorage` y no había otra forma de
limpiarlos; aquí viven en tu Postgres, donde puedes borrar lo que quieras desde
el panel de Supabase, y un botón así en la interfaz es sólo un riesgo sin
ventaja.

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
- **Fase 4 — Que trabaje sola.** El reloj, los dos avisos push y las dos
  funciones con Claude ("Planear mi día" y partir una tarea en pasos) ya están.
  Falta el mismo resumen por Telegram, para que llegue aunque el navegador tenga
  los avisos apagados.

El detalle de cada una está en `PLAN.md`.
