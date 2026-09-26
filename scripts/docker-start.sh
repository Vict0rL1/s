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

DB="${DATA_DIR:-/data}/tennis.db"

if [ ! -f "$DB" ]; then
  echo "→ Disco vacío: instalando la base de datos de la imagen en $DB"
  mkdir -p "$(dirname "$DB")"
  cp /seed/tennis.db "$DB"
  echo "   $(du -m "$DB" | cut -f1) MB instalados"
else
  echo "→ Base ya presente en $DB ($(du -m "$DB" | cut -f1) MB) — no se toca"
fi

exec npx tsx server/src/index.ts
