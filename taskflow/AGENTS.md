# TaskFlow — notas para agentes

Las reglas del proyecto están en **`CLAUDE.md`** y el plan de construcción en
**`PLAN.md`**. Léelos primero; este archivo sólo guarda las notas de la
herramienta.

`next dev` escribe y mantiene el bloque de abajo por su cuenta. Vive aquí, y no
en `CLAUDE.md`, para no ensuciar las reglas escritas a mano.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
