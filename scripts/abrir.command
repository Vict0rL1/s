#!/bin/bash
# Doble clic en Finder y la app se abre. Sin terminal, sin comandos.
#
# ===========================================================================
# POR QUÉ ESTE FICHERO EXISTE
# ===========================================================================
# `npm run go` ya es un solo comando, pero sigue pidiendo tres cosas: abrir la
# Terminal, acordarse de la carpeta, y escribirlo. Un .command se abre con doble
# clic desde el Finder como cualquier aplicación, así que no pide ninguna.
#
# ===========================================================================
# EL PROBLEMA QUE TIENE UN .command Y QUE ESTE RESUELVE
# ===========================================================================
# El Finder lo lanza con un shell que NO ha leído tu ~/.zshrc. Si instalaste Node
# con nvm —lo más común en un Mac— `npm` sencillamente no existe en ese PATH, y el
# doble clic abre una ventana que dice «command not found: npm» y se cierra.
#
# Por eso esto busca Node antes de rendirse: primero carga nvm si está, y si no
# prueba los sitios donde lo dejan Homebrew (Apple Silicon e Intel) y el instalador
# oficial. Y si aun así no aparece, lo DICE, con la solución escrita, en vez de
# cerrarse dejando una ventana en blanco.

set -u

# El repositorio es la carpeta que contiene a esta, resuelta desde el propio
# fichero: así funciona esté donde esté el proyecto y aunque lo muevas.
cd "$(dirname "$0")/.." || {
  echo "No he podido entrar en la carpeta del proyecto."
  read -r -p "Pulsa Enter para cerrar."
  exit 1
}

echo "Sports Predictor — $(pwd)"
echo ""

# --- Encontrar Node ---------------------------------------------------------
if ! command -v npm >/dev/null 2>&1; then
  # nvm: lo normal en un Mac, y lo que el Finder no carga.
  if [ -s "$HOME/.nvm/nvm.sh" ]; then
    # shellcheck disable=SC1091
    . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
  fi
fi
if ! command -v npm >/dev/null 2>&1; then
  for dir in /opt/homebrew/bin /usr/local/bin "$HOME/.volta/bin" "$HOME/.local/bin"; do
    if [ -x "$dir/npm" ]; then
      PATH="$dir:$PATH"
      export PATH
      break
    fi
  done
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "No encuentro Node/npm desde el Finder."
  echo ""
  echo "No significa que no lo tengas: el Finder lanza esto con un entorno que no"
  echo "ha leído tu ~/.zshrc, así que un Node instalado con nvm no aparece."
  echo ""
  echo "Ábrelo desde la Terminal y funcionará:"
  echo "    cd \"$(pwd)\" && npm run go"
  echo ""
  read -r -p "Pulsa Enter para cerrar."
  exit 1
fi

# --- Arrancar ---------------------------------------------------------------
npm run go
estado=$?

# La ventana NO se cierra sola al terminar. Si algo falló, el mensaje que lo explica
# está justo arriba, y cerrarla lo haría desaparecer antes de que nadie lo lea.
echo ""
if [ $estado -ne 0 ]; then
  echo "La app terminó con un error (código $estado). El motivo está arriba."
else
  echo "App cerrada."
fi
read -r -p "Pulsa Enter para cerrar esta ventana."
