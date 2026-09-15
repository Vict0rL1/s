# TaskFlow

App personal de productividad de Victor. Un solo usuario. Next.js + Supabase,
desplegada en Vercel.

Lee `PLAN.md` antes de empezar cualquier fase. `reference/cumbre.html` es la
versión que ya funciona: la UI, el parser de captura rápida y el importador
de `.ics` salen de ahí — pórtalos, no los reescribas desde cero. Ese archivo
conserva el nombre viejo de la app (Cumbre) porque es la foto del artifact
publicado; no lo renombres.

## Reglas del proyecto

**Idioma.** La interfaz y los mensajes al usuario van en español. El código
(nombres de variables, funciones, tablas, columnas, commits) en inglés.

**Secretos.** Nunca escribas un token, key o secreto en un archivo que se
commitea, ni siquiera "temporalmente" para probar. Van en `.env.local`, que
está en `.gitignore`. Si necesitas uno que no existe, agrégalo a
`.env.example` con el valor vacío y dile a Victor que lo llene él.

**Datos del usuario.** El sync jamás pisa una edición manual. Si una fila de
`tasks` tiene `user_edited_at`, el sync sólo actualiza `title`, `due_date` y
`due_time`; nunca `done`, `priority`, `area` ni `est_minutes`. Esto no es
negociable — una app que desmarca tareas hechas se deja de usar.

**RLS.** Toda tabla nueva lleva `enable row level security` y una política
`auth.uid() = user_id` en la misma migración que la crea. No dejes esto
"para después".

**Service role key.** Sólo en route handlers. Si la ves importada en un
componente cliente, es un bug de seguridad, no un detalle de estilo.

## Cómo está armado

```
app/                 rutas de Next (App Router)
  api/sync/          route handlers de Canvas y Google Calendar
lib/
  parse.ts           captura rápida — portado de reference/cumbre.html
  ics.ts             importador .ics de respaldo
  supabase/          clientes (browser y server)
supabase/schema.sql  esquema completo, idempotente
reference/           la versión artifact que funciona hoy
```

## Estilos

Copia el sistema de tokens CSS de `reference/cumbre.html`: variables en
`:root`, redefinidas en `@media (prefers-color-scheme: dark)` y en
`[data-theme="dark"]`. Ningún color se define sólo dentro de un bloque de
tema — eso produce texto de un tema sobre el fondo del otro.

No instales Tailwind ni una librería de componentes. El CSS ya está resuelto y
es corto.

## Fechas

- Deadline sin hora → columna `date`. Con hora → `timestamptz`.
- Todo lo que se muestre se convierte a `America/Vancouver` (el campo
  `timezone` del perfil), no a la zona del servidor de Vercel, que es UTC.
- Los minutos de `blocks` (`start_min`, `end_min`) son hora local, no UTC.

## Qué probar

Escribe tests de estas dos cosas y de nada más por ahora:

1. `lib/parse.ts` — que `"Problem set 4 #SFU vie 3pm 90m"` salga con área,
   fecha del próximo viernes, hora 15:00 y 90 minutos.
2. El mapeo de Canvas — que correr el sync dos veces sobre la misma respuesta
   deje exactamente las mismas filas.

La UI se prueba abriéndola.

## Commits

Mensajes en inglés, imperativo, una línea. Commitea al terminar cada parte
que funcione, no al final de la fase.
