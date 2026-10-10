# Sports Predictor

Monorepo: `server/` (Fastify 5, node:sqlite, tsx) + `web/` (React 19, Vite 6). Seven sports:
football, basketball, baseball, NFL, NHL, UFC and tennis. `data/history.db` can be rebuilt from
the sources; `data/ledger.db` (predictions, bets, paper bank, policy) cannot: it is irreplaceable.
Plans and decisions live in `docs/plans/`; every change gets a `CHANGELOG.md` entry.

## Hard rules

- Never touch the holdouts and never use `--unlock`.
- Never UPDATE or DELETE immutable ledger rows (the triggers say «no se reescribe» / «no se borra»).
- Never invent data: what is missing is DESCONOCIDO, never a plausible value.
- Model parameters change only through `experiments/registry.jsonl` and model versioning.
- User-facing copy goes through the i18n catalog: `web/src/i18n/es.ts` is the source, `en.ts`
  mirrors it line by line. Design tokens live in `web/src/lib/theme.ts` and `web/src/index.css`.
- No CDN assets. Never commit `.env` or a real `ODDS_API_KEY`. Tests never use the network.
- Reproduce a defect with a failing test before fixing it. If a finding is wrong, say so with
  evidence and do not "fix" working code.

## Never run unless the owner asks

`npm run odds` (spends API credits) · `npm run restore` · `npm run fetch-data -- --force` ·
`fly deploy` · `git push --force` · anything with `--unlock`. These are also denied in
`.claude/settings.json`.

## How to verify

```
npm run typecheck && npm run lint && npm test && npm run build && npm run verify:data && npm run audit
cd web && npx playwright test
```

`npm run doctor -- --sin-red` exits 1 without `ODDS_API_KEY`: that is expected here. Commit with
`git -c core.hooksPath=.githooks commit` (the hook runs the secret scanner).

## Agents (`.claude/agents/`)

- `test-runner`: runs the whole check suite and reports only what failed. After any change and
  before every commit.
- `security-reviewer`: read-only review of auth, sessions, TOTP, rate limits, headers/CSP,
  static serving, notifications, Docker and secrets.
- `data-guardian`: read-only review of databases, migrations, ingests, backup/restore, retention
  and the scheduler. Must review those changes before they are committed.
- `quant-reviewer`: read-only review of models, holdouts, leakage, calibration, staking, paper
  bank, strategies, parlays, de-vig, CLV, ROI and new sport publications.
- `ui-tester`: runs the built app in a real browser at 1280 and 390 px, light and dark.
  After any change under `web/`, static serving or auth.
- `fixer`: implements ONE reviewed finding with a failing test first. Never open-ended work.
