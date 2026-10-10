#!/bin/sh
# Lo que pasa entre que Fly arranca la máquina y el servidor escucha.
#
# ===========================================================================
# LA ÚNICA DECISIÓN QUE TOMA ESTE FICHERO
# ===========================================================================
# Si el disco persistente está vacío, copiarle la base que viaja en la imagen. Si no,
# NO TOCARLA.
#
# Esa segunda mitad es la importante y es la razón de que esto sea un script y no una
# línea en el Dockerfile. Copiar siempre sería una línea, funcionaría el primer día, y
# en cada despliegue posterior machacaría en silencio el registro de apuestas y todo lo
# actualizado desde la nube con la foto del día que se construyó la imagen. La app
# arrancaría perfectamente después, con datos viejos y sin las apuestas.

set -eu

DATA="${DATA_DIR:-/data}"
HISTORY="$DATA/history.db"
LEGACY="$DATA/tennis.db"

# Desde la Fase 2 la base son dos ficheros: history.db (historia, reconstruible; es la que
# viaja en la imagen) y ledger.db (apuestas, predicciones registradas, precios observados;
# NUNCA viaja en la imagen: lo crea el servidor vacío la primera vez y a partir de ahí es
# tuyo). Un disco con el tennis.db antiguo tampoco se toca: el servidor lo parte en dos al
# arrancar y deja el original al lado como tennis.db.pre-split-<fecha>.
if [ -f "$HISTORY" ]; then
  echo "→ Base ya presente en $HISTORY ($(du -m "$HISTORY" | cut -f1) MB) — no se toca"
elif [ -f "$LEGACY" ]; then
  echo "→ Base antigua en $LEGACY: el servidor la partirá en history.db + ledger.db al arrancar — no se copia nada"
else
  echo "→ Disco vacío: instalando la historia de la imagen en $HISTORY"
  mkdir -p "$DATA"
  cp /seed/history.db "$HISTORY"
  echo "   $(du -m "$HISTORY" | cut -f1) MB instalados"
fi

# ---------------------------------------------------------------------------
# SOLTAR LOS PRIVILEGIOS (lote A, A4)
# ---------------------------------------------------------------------------
# El volumen de Fly se monta propiedad de root, así que la imagen no puede fijar `USER node`
# sin dejar /data ilegible. Root hace solo lo de arriba (copiar la semilla) y cederle el
# disco a node; el servidor corre como node. Y el tsx es el instalado con las dependencias
# (fijado en server/package.json), no uno que npx descargue en cada arranque frío.
if [ "$(id -u)" = "0" ] && chown -R node:node "$DATA"; then
  if command -v setpriv >/dev/null 2>&1; then
    exec setpriv --reuid=node --regid=node --init-groups node_modules/.bin/tsx server/src/index.ts
  elif command -v runuser >/dev/null 2>&1; then
    exec runuser -u node -- node_modules/.bin/tsx server/src/index.ts
  fi
  echo "⚠ ni setpriv ni runuser en la imagen: el servidor corre como root"
fi
exec node_modules/.bin/tsx server/src/index.ts
