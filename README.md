# 🎾 Tennis Predictor

Aplicación web + API REST para **predecir resultados de partidos de tenis** (ATP y WTA,
singles) combinando historial partido a partido, **ratings Elo por superficie**, forma
reciente, head-to-head y **odds de casas de apuestas**.

El modelo es **explicable, no una caja negra**: cada señal se expresa en puntos Elo y se
muestra lado a lado con la probabilidad implícita del mercado, incluyendo la detección de
posible *value* cuando el modelo discrepa de las cuotas.

> ⚠️ **Aviso**: es una estimación estadística, **no** una certeza ni una recomendación para
> apostar. No considera lesiones de último momento, clima ni motivación (p. ej. exhibiciones).

![dashboard](docs/dashboard.png)

---

## Qué incluye

- **ATP y WTA**, singles. Torneos configurables (4 Grand Slams + Masters 1000 / WTA 1000 de
  fábrica) en `config/tournaments.json` — se amplía agregando entradas, sin tocar la lógica.
- **Elo general + por superficie** (dura / arcilla / hierba) con K-factor dinámico.
- **Forma reciente**, **head-to-head** y **comparación contra el mercado** (probabilidad
  implícita sin vig + detección de value).
- **Probabilidad de victoria en grande** para cada jugador (con un decimal), y todas las cifras
  consistentes entre sí: los dos lados siempre suman exactamente 100.0%.
- **Datos de cada jugador en el partido**: ranking oficial ATP/WTA + puntos, país, edad y mano.
  Se muestran aunque el modelo no pueda predecir (jugador sin partidos en el historial), y en ese
  caso también se muestra la probabilidad implícita del mercado.
- **Modelo calibrado y verificado:** `npm run backtest` mide la exactitud real (65.8% de acierto
  y calibración dentro de ~1 pp entre 50–90% en 6.022 partidos ATP out-of-sample). Ver
  [docs/MODEL.md](docs/MODEL.md).
- **Resumen "qué es lo más probable"** en cada partido: en lenguaje natural, con el favorito,
  su probabilidad, el marcador probable y las razones (superficie, forma, H2H, saque, mercado).
- **Desglose completo por partido**: explicación de *por qué* gana X (qué señal pesa más),
  ranking por Elo, últimos 5 resultados, récord en la superficie, comparativa de saque/quiebre
  (ace%, 1er saque, break points salvados) y marcador estimado.
- **Partidos próximos reales + auto-actualización:** con una API key, la app descubre los
  torneos de tenis activos ahora, trae sus partidos y refresca las odds sola cada pocas horas
  (o al pulsar *Actualizar*).
- **Dashboard** para elegir circuito y torneo, ver próximos partidos con barras
  modelo-vs-mercado, perfil de jugador (Elo por superficie + saque/quiebre + últimos
  resultados) y H2H.
- Datos guardados localmente en **SQLite** (`data/tennis.db`) para no depender de llamadas
  repetidas a las APIs.

## Fuentes de datos

| Tipo | Fuente | Por qué |
|------|--------|---------|
| Histórico | [Jeff Sackmann `tennis_atp` / `tennis_wta`](https://github.com/JeffSackmann/tennis_atp) | Gratis, sin API key, partido a partido desde décadas atrás, con superficie, ronda, sets y estadísticas de saque/quiebre. Estándar de facto para Elo de tenis. |
| Datos de jugador | Archivos de **rankings oficiales** y biografías del mismo repo de Sackmann | Ranking ATP/WTA + puntos, país, mano y fecha de nacimiento. Misma fuente ya en uso (el ATP Tour no ofrece API pública, y hacer scraping de su web sería frágil y de legalidad dudosa). |
| Odds | [The Odds API](https://the-odds-api.com) | Cuotas head-to-head de partidos próximos ATP/WTA. Plan gratuito (500 req/mes). Requiere API key. |

---

## Requisitos

- **Node.js ≥ 22.5** (usa el módulo integrado `node:sqlite`, sin dependencias nativas).

## Instalación

```bash
git clone <este-repo>
cd <repo>
npm install
cp .env.example .env    # opcional: para odds reales, ver abajo
```

## Puesta en marcha rápida (con datos de demostración, sin internet)

```bash
npm run seed     # carga un dataset de muestra en data/tennis.db
npm run dev      # levanta API (:4000) + frontend (:5173)
```

Abre **http://localhost:5173**. Elige ATP/WTA y un torneo (Wimbledon, US Open…), verás los
próximos partidos con la predicción del modelo y las odds lado a lado.

> El seed usa **datos sintéticos** (nombres reales, partidos simulados) para que la app
> funcione end-to-end sin conexión. El badge "datos demo" lo indica. Reemplázalo con datos
> reales usando `npm run update-data`.

---

## Odds reales y partidos próximos (The Odds API)

Los partidos próximos **reales** (los que se juegan hoy/esta semana) y sus cuotas vienen de
The Odds API. Sin key, la app muestra un demo con partidos de ejemplo.

1. Regístrate gratis en **https://the-odds-api.com** y copia tu API key (botón *Get API Key*).
   El plan gratuito da 500 requests/mes.
2. En tu archivo `.env`:

   ```bash
   ODDS_API_KEY=tu_clave_aqui
   ODDS_REGIONS=eu,uk
   ```

   (NUNCA subas tu `.env` — está en `.gitignore`.)
3. Ejecuta `npm run update-data`. La ingesta **descubre automáticamente los torneos de tenis
   activos** en ese momento (Grand Slams, Masters/1000, 500…) y trae sus partidos, así aparece
   lo que realmente se juega hoy — no una lista fija.

### Que se actualice solo

Con la key configurada, el servidor **refresca las odds automáticamente** mientras corre
(al arrancar y cada `AUTO_REFRESH_MINUTES`, 6 h por defecto). También puedes pulsar
**↻ Actualizar** en el dashboard para refrescar al instante. La cabecera muestra la hora de la
última actualización.

## Actualizar datos (histórico + odds)

```bash
npm run update-data
# opciones:
npm run update-data -- --from 2015 --to 2025    # rango de temporadas
npm run update-data -- --tour atp               # solo un circuito
npm run update-data -- --skip-odds              # solo histórico
```

Esto:
1. Descarga los CSV de Sackmann para el rango de años (cacheados en `data/raw/`).
2. Recalcula todos los ratings Elo.
3. Descarga odds en vivo de The Odds API (o genera fixtures si no hay key / fuera de temporada).

> `update-data` necesita acceso a internet (GitHub + The Odds API). En entornos sin red usa
> `npm run seed`.

### Método manual (si la descarga automática falla)

Funciona siempre, sin git y sin credenciales. Útil si tu red filtra GitHub o si `git` tiene
credenciales guardadas que GitHub rechaza:

1. Abre https://github.com/JeffSackmann/tennis_atp → botón verde **Code** → **Download ZIP**.
2. Repite con https://github.com/JeffSackmann/tennis_wta.
3. Mueve los dos ZIP **sin renombrar ni descomprimir** a la carpeta `data/raw/` del proyecto.
4. Ejecuta `npm run update-data`. La app detecta los ZIP, los descomprime sola y los usa.

`npm run update-data -- --fresh` limpia la caché de descargas pero **conserva** los ZIP que hayas
puesto a mano, así que puedes reintentar sin volver a descargarlos.

---

## Scripts

| Comando | Qué hace |
|---------|----------|
| `npm run dev` | Levanta backend + frontend a la vez |
| `npm run seed` | Carga el dataset de demostración |
| `npm run update-data` | Refresca histórico real + odds |
| `npm run backtest` | Mide la exactitud del modelo (accuracy, Brier, calibración) |
| `npm run build` | Build de producción del frontend + typecheck del backend |
| `npm run typecheck` | Chequeo de tipos de ambos workspaces |

## API REST (puerto 4000)

| Endpoint | Descripción |
|----------|-------------|
| `GET /api/meta` | Fuente de datos y conteos |
| `GET /api/tours` | Circuitos ATP/WTA con conteos |
| `GET /api/tours/:tour/players?q=` | Jugadores (búsqueda) |
| `GET /api/players/:tour/:id` | Perfil: Elo general + por superficie + últimos resultados |
| `GET /api/tournaments?tour=` | Torneos configurados y cuáles tienen partidos próximos |
| `GET /api/matches/upcoming?tour=&tournament=` | Próximos partidos con odds y predicción |
| `GET /api/h2h?tour=&p1=&p2=` | Head-to-head entre dos jugadores |
| `GET /api/predictions/:id` | Predicción completa de un partido próximo |
| `GET /api/predictions?tournament=` | Predicciones de todos los próximos de un torneo |
| `POST /api/predict` | Predicción ad-hoc `{tour, p1, p2, surface, odds1?, odds2?}` |

## Estructura del proyecto

```
config/        tours.json + tournaments.json  (ampliar aquí, no en el código)
data/          SQLite + CSV crudos + dataset seed
docs/          MODEL.md — cómo funciona el modelo
server/        API REST (Fastify) + ingesta + modelo Elo   (TypeScript)
web/           Dashboard (React + Vite + Tailwind)          (TypeScript)
```

## Cómo funciona el modelo

Ver **[docs/MODEL.md](docs/MODEL.md)** para la explicación completa del cálculo del Elo, cómo
se combinan las señales y las limitaciones. La lógica también está comentada en el código
(`server/src/model/`).
