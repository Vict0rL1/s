# La imagen que corre en Fly.io.
#
# ===========================================================================
# DOS ETAPAS, Y LA RAZÓN NO ES EL TAMAÑO
# ===========================================================================
# La primera construye el frontend; la segunda solo lleva lo necesario para servir. Lo
# que se gana no es tanto espacio como SUPERFICIE: en la imagen final no hay compilador
# de TypeScript, ni Vite, ni las 190 dependencias de desarrollo. Menos cosas instaladas
# en una máquina expuesta a internet es menos que puede fallar.
#
# ===========================================================================
# POR QUÉ SIGUE SIENDO `tsx` Y NO JAVASCRIPT COMPILADO
# ===========================================================================
# El servidor se ejecuta con `tsx`, que compila TypeScript al vuelo. Lo habitual sería
# compilar a JS en la primera etapa y correr `node dist/index.js`. No se hace porque todo
# el proyecto importa con extensión `.ts` explícita —`import { getDb } from './db.ts'`—,
# que es lo que permite ejecutarlo sin paso de build en desarrollo. Cambiarlo para el
# despliegue significaría tocar los 160 ficheros del servidor y tener dos formas
# distintas de arrancar la misma app, una de ellas probada solo en producción.
#
# `tsx` en la imagen final es una dependencia más y un poco de arranque. Barato. Por eso es
# una dependencia normal del servidor, fijada a una versión exacta (lote A, A4): antes era de
# desarrollo, `--omit=dev` la dejaba fuera y `npx tsx` la descargaba sin fijar en cada
# arranque frío, como root. El arranque la ejecuta desde node_modules/.bin y suelta los
# privilegios a `node` (ver scripts/docker-start.sh).

# ---------------------------------------------------------------------------
# Etapa 1: construir el frontend
# ---------------------------------------------------------------------------
FROM node:22-slim AS build
WORKDIR /app

# Primero los manifiestos, y solo ellos: Docker cachea cada capa por su contenido, así
# que mientras no cambien las dependencias esta capa se reutiliza y `npm ci` no se repite
# en cada despliegue. Copiar todo el proyecto antes anularía la caché con cualquier
# cambio en cualquier fichero.
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci

COPY . .
RUN npm run build --workspace web

# La SEMILLA, exportada aquí y no copiada tal cual (lote B, B5): `db:export-history` hace un
# `VACUUM INTO` de data/history.db (con lo que haya en history.db-wal: por eso el WAL entra en
# el contexto) y la comprueba con `integrity_check`. El fichero crudo perdía las páginas del WAL.
RUN mkdir -p /seed && npm run db:export-history --workspace server -- /seed/history.db

# ---------------------------------------------------------------------------
# Etapa 2: la imagen que se ejecuta
# ---------------------------------------------------------------------------
FROM node:22-slim AS run
WORKDIR /app

ENV NODE_ENV=production
# La base NO vive en la imagen: vive en el disco que Fly monta aquí. Una imagen se
# reemplaza entera en cada despliegue, así que una base dentro de ella se borraría —con
# el registro de apuestas— en cada `fly deploy`, sin error y sin aviso.
ENV DATA_DIR=/data
ENV WEB_DIST=/app/web/dist
ENV PORT=8080

# `--omit=dev` deja fuera Vite, TypeScript, oxlint y demás: no se sirve con ellos.
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev --workspace server --include-workspace-root

COPY server ./server
COPY config ./config
COPY --from=build /app/web/dist ./web/dist

# La HISTORIA de semilla viaja en la imagen y el arranque la copia al disco SOLO si está
# vacío (ver docker-start.sh). Así el primer despliegue funciona sin subir nada a mano, y
# los siguientes no pisan los datos que ya haya. El libro mayor (ledger.db) no viaja nunca:
# nace vacío en el disco persistente y es tuyo (.dockerignore lo deja fuera del contexto). Si aún
# tienes el tennis.db antiguo en local, `npm run db:migrate` lo parte y deja el history.db que la
# exportación de arriba necesita.
COPY --from=build /seed/history.db /seed/history.db
COPY scripts/docker-start.sh /app/docker-start.sh
RUN chmod +x /app/docker-start.sh

EXPOSE 8080
CMD ["/app/docker-start.sh"]
