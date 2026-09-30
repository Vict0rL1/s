#!/usr/bin/env bash
#
# Arranca backend y frontend juntos en una sola terminal.
#
#   ./start.sh
#
# Ctrl+C para en el mismo comando los dos procesos. En la primera ejecución
# crea el entorno virtual e instala dependencias; después arranca directo.

set -uo pipefail
cd "$(dirname "$0")"

# Control de trabajos: hace que cada proceso en segundo plano tenga su propio
# grupo, para poder matarlo con sus hijos de una vez. uvicorn --reload y vite
# lanzan subprocesos que si no quedan huérfanos ocupando los puertos.
# (macOS no trae `setsid`, así que esta es la vía portable.)
set -m

BOLD=$'\033[1m'; DIM=$'\033[2m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'
RED=$'\033[31m'; BLUE=$'\033[34m'; RESET=$'\033[0m'

BACKEND_PID=""
FRONTEND_PID=""

cleanup() {
  printf '\n%sParando…%s\n' "$DIM" "$RESET"
  # uvicorn --reload y vite lanzan procesos hijos: se mata el grupo entero.
  [[ -n "$BACKEND_PID" ]] && kill -TERM -"$BACKEND_PID" 2>/dev/null
  [[ -n "$FRONTEND_PID" ]] && kill -TERM -"$FRONTEND_PID" 2>/dev/null
  sleep 0.5
  [[ -n "$BACKEND_PID" ]] && kill -KILL -"$BACKEND_PID" 2>/dev/null
  [[ -n "$FRONTEND_PID" ]] && kill -KILL -"$FRONTEND_PID" 2>/dev/null
  printf '%sListo.%s\n' "$GREEN" "$RESET"
  exit 0
}
trap cleanup INT TERM

die() { printf '%s✗ %s%s\n' "$RED" "$1" "$RESET" >&2; exit 1; }
step() { printf '%s▸ %s%s\n' "$BLUE" "$1" "$RESET"; }

# --- Comprobaciones previas -------------------------------------------------

command -v python3 >/dev/null || die "No encuentro python3. Instálalo desde python.org"
command -v npm >/dev/null || die "No encuentro npm. Instala Node.js desde nodejs.org"

PY_MINOR=$(python3 -c 'import sys; print(sys.version_info[1])')
if (( PY_MINOR < 11 )); then
  die "Necesitas Python 3.11+. Tienes 3.$PY_MINOR — instálalo desde python.org"
fi

if [[ ! -f .env ]]; then
  printf '%s⚠ No hay archivo .env.%s Creándolo desde la plantilla…\n' "$YELLOW" "$RESET"
  cp .env.example .env
  printf '  Edítalo con tus API keys:  %sopen -e %s/.env%s\n\n' "$BOLD" "$PWD" "$RESET"
fi

# Puertos ocupados por una ejecución anterior que no se cerró bien.
for port in 8000 5173; do
  if lsof -ti tcp:"$port" >/dev/null 2>&1; then
    printf '%s⚠ El puerto %s está ocupado. Liberándolo…%s\n' "$YELLOW" "$port" "$RESET"
    lsof -ti tcp:"$port" | xargs kill -9 2>/dev/null
  fi
done

# --- Backend ----------------------------------------------------------------

if [[ ! -d backend/.venv ]]; then
  step "Primera ejecución: creando el entorno de Python (tarda un par de minutos)…"
  python3 -m venv backend/.venv || die "No pude crear el entorno virtual"
fi

# Instala dependencias solo si requirements.txt cambió desde la última vez.
REQ_STAMP=backend/.venv/.requirements-hash
REQ_HASH=$(shasum backend/requirements.txt | cut -d' ' -f1)
if [[ ! -f $REQ_STAMP || $(cat "$REQ_STAMP") != "$REQ_HASH" ]]; then
  step "Instalando dependencias de Python…"
  backend/.venv/bin/pip install --quiet --upgrade pip
  backend/.venv/bin/pip install --quiet -r backend/requirements.txt \
    || die "Falló la instalación de dependencias de Python"
  echo "$REQ_HASH" > "$REQ_STAMP"
fi

if [[ ! -d frontend/node_modules ]]; then
  step "Instalando dependencias de Node (tarda un par de minutos)…"
  (cd frontend && npm install --silent) || die "Falló npm install"
fi

# --- Arranque ---------------------------------------------------------------

step "Arrancando backend…"
(cd backend && exec .venv/bin/python -m uvicorn app.main:app --reload --port 8000) \
  > /tmp/bolsa-backend.log 2>&1 &
BACKEND_PID=$!

# Espera a que el backend responda antes de seguir.
for _ in $(seq 1 40); do
  if curl -s http://localhost:8000/api/meta/health >/dev/null 2>&1; then break; fi
  sleep 0.5
done

if ! curl -s http://localhost:8000/api/meta/health >/dev/null 2>&1; then
  printf '%s✗ El backend no arrancó. Últimas líneas del log:%s\n' "$RED" "$RESET"
  tail -20 /tmp/bolsa-backend.log
  exit 1
fi

step "Arrancando frontend…"
(cd frontend && exec npm run dev) > /tmp/bolsa-frontend.log 2>&1 &
FRONTEND_PID=$!

for _ in $(seq 1 40); do
  if curl -s http://localhost:5173 >/dev/null 2>&1; then break; fi
  sleep 0.5
done

printf '\n%s%s✓ Todo listo%s\n\n' "$GREEN" "$BOLD" "$RESET"
printf '  App:       %shttp://localhost:5173%s\n' "$BOLD" "$RESET"
printf '  API docs:  %shttp://localhost:8000/docs%s\n\n' "$DIM" "$RESET"
printf '  Logs:      %stail -f /tmp/bolsa-backend.log%s\n' "$DIM" "$RESET"
printf '             %stail -f /tmp/bolsa-frontend.log%s\n\n' "$DIM" "$RESET"
printf '  %sCtrl+C para parar los dos.%s\n\n' "$DIM" "$RESET"

# Si cualquiera de los dos muere por su cuenta, avisa y para el otro.
while true; do
  if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
    printf '%s✗ El backend se detuvo. Últimas líneas:%s\n' "$RED" "$RESET"
    tail -20 /tmp/bolsa-backend.log
    cleanup
  fi
  if ! kill -0 "$FRONTEND_PID" 2>/dev/null; then
    printf '%s✗ El frontend se detuvo. Últimas líneas:%s\n' "$RED" "$RESET"
    tail -20 /tmp/bolsa-frontend.log
    cleanup
  fi
  sleep 2
done
