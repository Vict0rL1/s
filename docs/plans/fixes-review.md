# Sports Predictor — fixes from the 8 Oct 2026 review

> Texto de la revisión del 8 de octubre de 2026, tal como se entregó para los lotes A–F
> (`docs/plans/fixes-A.md` … `fixes-F.md`). Se guarda aquí para el seguimiento con los agentes
> del proyecto (`.claude/agents/`).

You are working on Sports Predictor (repo `Vict0rL1/s`, branch `claude/tennis-prediction-app-jlhgxh`). The nine-phase roadmap is done and merged to `main` (PR #4). An independent review found real defects. Every item below was verified by reading the code end to end, and most were reproduced with a probe or a throwaway test. Fix them in the batch order below.
Rules (unchanged)

* Never touch the holdouts and never use `--unlock`. Never modify or delete rows in immutable tables. Never invent data. Model parameters change only through the experiment registry.
* For each batch: write `docs/plans/fixes-<batch>.md` first. Reproduce each defect with a failing test before fixing it. Then fix, and finish with doctor, tests, `verify:data`, `audit`, typecheck, lint, build and Playwright all green. Commit per batch and update `CHANGELOG.md`.
* If a finding turns out to be wrong when you reproduce it, say so in the plan with the evidence and skip it. Do not "fix" working code.

Batch A — Blockers (fix before any deploy)
A1. In production the web app sits behind the login, so nobody can open it.

* Files: `server/src/app.ts` (static and SPA fallback registered under the auth hook), `server/src/auth.ts:95-125`.
* Reproduced: with `NODE_ENV=production APP_PASSWORD=…`, `GET /` with `Accept: text/html` returns `401 {"error":"Contraseña requerida"}`. `/assets/*.js` also returns 401. There is no `WWW-Authenticate` header, so the browser shows no prompt and `Login.tsx` never loads.
* Fix: exempt static, non-`/api` GETs (index.html, `/assets/*`, `sw.js`, manifest, icons). They contain no data.
* Test: add an e2e run with `APP_AUTH=on` and the built web served. It must show the login screen, log in, and reach `/destacados`. The current e2e runs with `APP_AUTH=off`, which is why this was missed.

A2. The login rate limit can be bypassed with a spoofed `X-Forwarded-For`.

* Files: `auth.ts:60-64` uses the leftmost XFF entry, with `trustProxy: true`.
* Reproduced: 12 wrong logins with a rotating XFF all returned 401, never 429. Without XFF the same requests were blocked after 4.
* Second effect: because the block check runs before the session check, an attacker can lock the owner out by spoofing the owner's IP.
* Third effect: the `estados` Map in `rateLimit.ts` is never pruned.
* Fix: key on `Fly-Client-IP` in production and on the socket address otherwise. Check the session before the block. Cap the Map and expire its entries.

A3. Basic Auth bypasses TOTP, and the API can switch 2FA off.

* Files: `auth.ts:112-113` (Basic accepts user and password only); `routes/ajustes.ts` lets `PATCH /api/features/auth.totp {on:false}` succeed.
* Fix: when TOTP is on, reject Basic Auth or require the code with it. Make `auth.*` and `seguridad.*` flags read-only over the API and hide them in Ajustes.
* Related: turning off `auth.sesiones` from Ajustes locks the owner out (the login returns 404) with no confirmation and no way back from the UI. Same fix: hide startup-only flags.

A4. The production image runs `npx tsx`, but tsx is a devDependency.

* Files: `Dockerfile:59`, `scripts/docker-start.sh:38`.
* Effect: npx may download an unpinned tsx on every cold boot, as root.
* Fix: move a pinned tsx to server dependencies, call the local binary, and add `USER node`.

A5. The basketball ingest empties the live tables before it fetches.

* Files: `basketball/scripts/updateData.ts:88-95`, now run every 6 h by the `resultados` job.
* Effect: during the fetch window, the pre-match job writes predictions made with initial Elo into the immutable `bb_prediction_log` / `prediction_snapshots`, and nobody can correct them afterwards.
* Fix: fetch first, then delete, insert and recompute ratings in one transaction (or upsert like football). Check tennis `resetData` for the same pattern.

A6. The paper bank and the strategies ignore the per-day and per-league caps.

* Files: `paper/bankroll.ts:608` and `estrategias/index.ts:230` call `decideEvent` (gates 1–6). Gates 7–8 (day 6 %, league 5 %, portfolio Kelly) live only in `staking/book.ts` `decideBook`, which is used only by `routes/staking.ts`.
* Reproduced: 6 EPL matches on one day each staked 20, totalling 100 (10 % of the bank) where the policy allows 50.
* Ajustes shows these limits as if they applied.
* Fix: run candidates through `decideBook`, or apply its day and league factors against open positions, before the trust and group caps. Add a test.

A7. A fresh install ends with an empty database.

* `fetch-data` returns 404: the `data-latest` release does not exist yet. The nightly `data.yml` only runs from `main`, which now has it, so check after the next 05:30 UTC run.
* Separately, `scripts/setup.mjs` runs `db:migrate` first, which creates an empty `history.db`. `fetch-data` then sees the file and skips the download, and setup prints "Listo".
* Fix: `fetch-data` should treat a schema-only `history.db` as absent, and setup should check row counts. If the release is missing, offer `update-all --skip-odds`.

Batch B — Data safety

1. `fetch-data --force` and `restore` are unsafe in WAL mode.
   * Defect: they copy and rename files without checkpointing, and leave the old `-wal`/`-shm` behind. Nothing closes the DB on SIGTERM.
   * Fix: refuse to run if the server holds the DB. Make every copy with `VACUUM INTO` and run `integrity_check`. Write to a temp file and rename. Delete the old `-wal`/`-shm`. Close the DB on SIGINT/SIGTERM.
   * Test: a real restore, done while a WAL file exists.
2. Move `odds_quote_state` to the ledger. It is updated in the same transaction as `odds_snapshots`, and a transaction across two attached files is not atomic in WAL.
3. Some `history.db` tables cannot be rebuilt. `fb_odds_history`, `fb_news`, `fb_lineups`, `latency_samples` and `player_ids` (which `prediction_log` depends on) are replaced or emptied by `fetch-data --force`. Move them to the ledger, or carry them over.
4. The split can leave the bets behind silently. If `ledger.db` is missing while `history.db` has data, ATTACH creates an empty ledger and the app starts. Refuse to start instead, and write a marker file once the split finishes.
5. Smaller fixes:
   * Set `PRAGMA ledger.synchronous=FULL`.
   * Clamp `BACKUP_HOURS` and `RESULTS_REFRESH_HOURS` to at most 7 days.
   * Fix the scheduler race when the cadence changes during a run (orphaned timer).
   * In retention, anchor on the latest `commence_time` in each group.
   * `check-publishable.mjs` should import `db/tables.ts` and check the exported file.
   * The Docker seed should COPY the output of `db:export-history`.
6. Abuse that needs no login:
   * Metrics labels come from raw paths, including 401s, so they grow without limit. Use `req.routeOptions.url`.
   * A malformed `sp_session` cookie throws inside the auth hook, causing a 500 and a 5 KB `error_log` row. Wrap the decode in try/catch, and cap or prune `error_log`.

Batch C — Money and model correctness

1. Parlay probability is inflated. `picks/parlay.ts:121-128` multiplies every same-day, same-league pair by a correlation factor using ρ = 0.0047, the upper bound of a CI around 0. It ignores which side each leg is on and compounds over n(n−1)/2 pairs.
   * Repro: 10 legs at p = 0.30 show +20.5 % "ventaja" where the independent EV is −26.3 %.
   * Fix: use ρ = 0 across different matches. Use the joint score matrix for legs in the same match. Cap the factor.
2. Surebets, steam and the market reference mix lines. `odds/intel.ts:117-126` combines −3.5 with +2.5, or over 47.5 with under 46.5.
   * Repro: a 3.6 % "surebet" that loses on a 3-point win.
   * Fix: reuse `deLaLineaMasCotizada` from `odds/lineas.ts` and require complementary lines.
3. The 60-minute steam window is not enforced. `intel.ts:99-103` compares against the previous point however old it is: a 12-hour drift counts as steam. Fix: return null when no point falls inside the window.
4. Drift monitoring compares two different probabilities. `monitoring/series.ts` measures the live published (market-blended) probability against the raw-model backtest reference, so for the NFL it can hide a 0.017 log-loss regression. Fix: compare like with like.
5. Strategies are not frozen.
   * Their team and player caps come from the current policy version, and `strategy_bets` store no `policy_version_id`.
   * The 3 % team cap also clips a strategy's first bet.
   * Fix: freeze the limits into `ConfigEstrategia`, and store the policy version on each bet.
6. The season simulation can drop games. "Pending" means `date ≥ today`, not "has no result yet", so late-night games and postponed matches fall out. Fix: pending = no matching result.
7. ROI has two definitions. Push, void and cancelled stakes are counted in `paper/bankroll.ts` and `evaluation/segmentos.ts` but not in `estrategias`. Use one shared helper.
8. CLV can be 0 by construction. When nothing was observed after the bet, the "close" is the bet's own price. Store CLV as null in that case.
9. One segment is chosen by the result. The segment dimension "ganó el visitante" picks rows by outcome. Replace it with the side of the pick.
10. Tennis paper bets settle by player name. Settle by id, or by the names stored in `prediction_log`.

Batch D — Interface (from running the app at 1280 and 390 px, and the frontend review)

1. The match page and Destacados give different probabilities for the same game.
   * Example: TB @ DAL shows 62.3 % (raw model) on `/partido` and 75.3 % (published) on Destacados.
   * Fix: make the published probability the headline everywhere. Show the raw model as a secondary line.
2. "De T-24h a la final" fills future horizons with the current snapshot. For a game 20 h away it shows T-6h, T-1h and the final, all at 75.3 %. Fix: show "pendiente" for any horizon whose time has not arrived.
3. The "Cómo le fue al modelo" panel takes over the first screen.
   * It opens expanded and fills the whole first screen on desktop and mobile, pushing the content below the fold.
   * On the Fútbol tab it lists NHL games first.
   * Fix: start it collapsed (remember the choice), and pre-filter it to the current sport on sport tabs.
4. Ajustes shows about 13 raw i18n keys. Examples: `staking.maxExposurePerLeague`, `grupos.maxSameTeamExposure`, `recortes.oodLeve`, `abstencion.precioViejoHoras`, `datos.backupProgramado`, `seguridad.errorLog`.
   * Its copy "las tarjetas se van traduciendo" is outdated.
   * Add a test that fails on any untranslated key in the rendered pages.
5. Number formatting bypasses Intl. 159 `pct()` and 189 `toFixed()` calls do, so "37.5%" sits next to "75,3 %". Route all of them through one Intl formatter. Use a non-breaking space in ranges like "60–70 %", which wraps today. Fix `PaperBankroll.tsx:61`.
6. Offline / service worker:
   * `NO_GUARDAR` lists `/api/stream`, but the SSE endpoint is `/api/latency/stream`. Bypass on `Accept: text/event-stream`.
   * Only cache ok `text/html` responses as the shell.
   * Clear the API cache on logout, and unregister the worker when the flag is off.
   * Do not cache `/api/bets*` or `/api/buscar`.
   * Show stale data with a cached-at header and the banner, even when `navigator.onLine` is true.
   * A cold start with the server unreachable must not leave a blank page: `estadoAuth` needs a catch.
7. A deploy can blank open tabs. Return 404 for missing `/assets/*` (not index.html), and add an ErrorBoundary that reloads on a chunk-load error.
8. Deep links and tab state:
   * `?dia=` is wiped on mount in Fútbol, Baloncesto, Béisbol, NFL and Tenis (and `?torneo=` in Tenis). Copy NHL's `dayGroups.length &&` guard.
   * Switching league or tour has a race: add a `vivo` flag or AbortController and clear `error`.
   * `Partido.tsx` keeps the previous match's state when the id changes.
9. The CSP has no `blob:` in `img-src`. Without it, "Mi selección → imagen" fails in production.
10. Dialogs:
   * The sports sheet, the filter sheet, the confirm dialog, the StatusPill and the tour need `aria-modal`, Escape to close, focus trap and focus return, plus a body scroll lock.
   * The 1–9 shortcuts must not fire while a dialog is open.
11. Ajustes form bugs:
   * A policy error replaces the form and leaves no way back.
   * A network failure leaves the dialog stuck on "Aplicando…".
   * The cadence field goes blank after a change.
   * The policy POST sends no base version.
   * Hiding a sport only updates the nav after a reload.
12. `StatusPill` and `Campana` are mounted twice. That doubles their polling, which also keeps running in hidden tabs.
13. Destacados cards are still dense.
   * They have two "add to selection" controls (the star and the button).
   * Apply the progressive disclosure from the roadmap: probability, odds vs fair and the confidence badge visible; everything else behind "¿por qué?".
14. Smaller interface fixes:
   * Without an odds key, Fútbol says "No hay partidos próximos… Es lo normal entre temporadas" in October. Say the real cause (fixtures come from the odds API) and how to fix it (`npm run clave`).
   * The EPL Elo table lists 30 teams, relegated ones included. Default to active teams.
   * Every error banner needs `role="alert"`.
   * The unlayered `:focus-visible { border-radius }` breaks rounded pills.
   * Plural rules: about 15 keys use "(s)".
15. The dev server is open to the local network. It binds `0.0.0.0` with auth off: anyone on the same Wi-Fi can read bets, spend odds credits and flip flags. Bind `127.0.0.1` unless `APP_AUTH=on`.
16. The secret scan can miss a staged secret. `secret-scan.mjs --staged` reads the working copy instead of `git show :<path>`.
17. SMTP allows cleartext. Set `requireTLS: true` for SMTP on port 587.

Batch E — Tests that would have caught these

1. e2e with auth on and the web served (A1).
2. The axe contrast filter keeps only `critical`, but contrast is rated `serious`, so it always passes. Fix it, and also run axe at 390 px and with a sheet open.
3. The e2e console filter drops "Failed to load resource", so API 500s pass. Stop dropping it.
4. A cold-start offline test.
5. The paper bank respects the per-day and per-league caps (A6).
6. A real ledger restore with a WAL present (B1).
7. The match page headline equals the Destacados probability (D1).
8. No raw i18n keys on any route (D4).
9. Under scheduler timing, the basketball ingest never exposes empty ratings to the pre-match job (A5).

Batch F — Data freshness (needs the owner's network or Fly)

* Tennis is stuck at 17 Jan 2026. `JeffSackmann/tennis_atp` and `tennis_wta` return 404, and TML is frozen. Make tennis-data.co.uk (ATP and WTA, with closing odds) the scheduled primary source on the owner's machine or Fly. Until tennis is current, mark the tab clearly as stale in Destacados and leave it out of the paper bank.
* MLB (2025 archive) and NBA/WNBA/NCAA: the MLB Stats API and ESPN are blocked in the cloud container but should work from the owner's network. Verify with `npm run update-results` there, and show the result in Diagnóstico.

When all batches are green, open a PR to `main` with the plans and a before/after table. Do not merge it.
