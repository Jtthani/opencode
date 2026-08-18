# Testing

This repo runs two CI gates on every push ([`.github/workflows/typecheck.yml`](.github/workflows/typecheck.yml) and
[`.github/workflows/test.yml`](.github/workflows/test.yml)), plus a nightly e2e regression run
([`.github/workflows/e2e-regression.yml`](.github/workflows/e2e-regression.yml)). This doc explains what each one
actually covers and, most importantly, **how to get your own tests running in CI** — it doesn't happen automatically.

## Typecheck

`bun turbo typecheck` runs `tsgo --noEmit` for every package that has a `typecheck` script. This one just works —
if your package has a `typecheck` script in `package.json`, it's already covered. Nothing to configure.

**Running out of memory locally?** Turbo's default concurrency (10) spawns enough parallel `tsgo` processes to exhaust
memory on a constrained machine — this is the same issue CI hit, which is why [`typecheck.yml`](.github/workflows/typecheck.yml)
runs with `--concurrency=4`. If you're in Docker (e.g. this repo's devcontainer) and hit an OOM kill, first try capping
concurrency the same way:

```bash
bun turbo typecheck --concurrency=4
```

If it still OOMs, increase the memory limit allocated to the Docker engine/VM (Docker Desktop: Settings → Resources →
Memory) rather than lowering concurrency further.

## Unit tests

`bun turbo test` (in `test.yml`'s `unit` job) is **not** the same as "every package's `test` script." [`turbo.json`](turbo.json)
only declares `test` as a task for a handful of packages:

```json
"opencode#test": { ... },
"@opencode-ai/core#test": { ... },
"@opencode-ai/app#test": { ... },
"@opencode-ai/ui#test": { ... },
"@opencode-ai/session-ui#test": { ... }
```

If your package isn't in that list, `bun turbo test` silently skips its `test` script in CI, even if you have real
tests and they pass locally. **If you add or change tests in a package that isn't listed, add an entry for it** —
see the comment directly above that block in `turbo.json` for the exact pattern. Only add the package(s) you
actually touched; don't add all of them back, that's what makes CI slow.

To run a package's tests locally regardless of what's wired into CI:

```bash
cd packages/<name>
bun test
```

(Tests are guarded against running from the repo root — see `AGENTS.md`.)

## Test coverage

Bun's test runner has coverage built in — no extra tooling to install. Run it from a package directory, same as
`bun test`:

```bash
cd packages/<name>
bun test --coverage                            # prints a per-file % table in the terminal
```

That's usually enough to see what's covered. For an HTML report you can click through:

```bash
bun test --coverage --coverage-reporter=lcov   # writes coverage/lcov.info
genhtml coverage/lcov.info -o coverage-html     # needs lcov installed (apt/brew install lcov)
open coverage-html/index.html                   # or just open the file in a browser
```

You can scope it to the file(s) you're touching instead of the whole package:

```bash
bun test --coverage src/some-feature.test.ts
```

A couple of things worth knowing:

- Coverage is per-package, same as tests — there's no repo-wide coverage report, and it's not run in CI or enforced
  with a threshold. It's a local tool for checking your own work before opening a PR.
- `coverage/` and `coverage-html/` are generated output, not source — don't commit them. They're gitignored.

## End-to-end (Playwright) tests

`packages/app/e2e/` has three tiers, and which one your test belongs in determines when it actually runs:

| Directory | Runs | Job |
| --- | --- | --- |
| `e2e/smoke/`, `e2e/user-story/` | every push | `test.yml` → `e2e (smoke)` |
| `e2e/regression/` | nightly (~5am ET) | `e2e-regression.yml` |
| `e2e/performance/` | manually / benchmarking, not in CI | — |

**The smoke suite is deliberately small.** It's the only e2e coverage that gates every push, so it only holds fast,
broad checks — enough to catch "the app doesn't render" or "the golden path is broken," not narrow edge cases. As of
this writing it's a handful of tests taking well under a minute combined. Keep it that way.

### Where to put a new test

- **Fast (a few seconds) and checks something broadly important** (a core render path, a critical user journey) →
  `e2e/smoke/` or `e2e/user-story/`.
- **Slow, or checks a narrow/specific behavior** (a particular edge case, a specific bug you fixed, a detailed
  interaction) → `e2e/regression/`. This is almost always the right place for a new test covering your change.

When in doubt, put it in `e2e/regression/` — a bug there gets caught the next night, not never. Only add to smoke if
your change touches something so central that every push should verify it.

If several tests share setup (mocking the server, seeding a session, DOM helpers), factor that into a `*.helpers.ts`
file next to the tests rather than duplicating it — see `e2e/smoke/session-timeline.helpers.ts`, which
`e2e/regression/session-timeline-history-scroll.spec.ts` imports from, for the pattern.

### Running e2e tests locally

```bash
cd packages/app
bun run test:e2e:local e2e/smoke e2e/user-story   # what runs on every push
bun run test:e2e:local e2e/regression             # what runs nightly
bun run test:e2e:local e2e/regression/my-new-test.spec.ts  # just your test
```

## Quick reference

```bash
bun turbo typecheck              # everything, from repo root
bun turbo test                   # only the packages wired into turbo.json (see above)
cd packages/<name> && bun test   # a specific package's tests, regardless of CI wiring
cd packages/app && bun run test:e2e:local e2e/<smoke|user-story|regression>
```
