# ED Journal Tool (EDJT)

Reads Elite Dangerous journal files into SQLite, builds stats from them, and serves an API and a React dashboard on port 4267. Node.js (ESM, `node:sqlite`) server in `src/`, React + Vite client in `client/`.

Read before changing an area:
- `README.md`: features, options, how ingestion and stats work, the API, releases.
- `docs/decisions.md`: why things are built the way they are (one short entry per decision). Add an entry when you make a decision that spans files or that someone would otherwise undo.
- The code's own comments: most "why" lives next to the code it's about.

## Commands

```sh
npm install && npm run client:install   # both package trees
npm start              # dev: server + Vite (hot reload) on http://localhost:4267
npm test               # node --test test/
npm run lint           # oxlint, server and client
npm run client:build   # client/dist
npm run dist           # executables in dist/ (Windows .exe, Linux binary and installer)
node src/index.mjs --help
```

The client hot-reloads; server changes need the server restarted.

## Rules

- **Never write to journal files** (the game's). EDJT only ever reads them.
- **Never change the real database** (`%LOCALAPPDATA%\edjt\journals.db`, `~/.local/share/edjt` on Linux) to try something. Migrations, resets and anything else that rewrites data get tried on a copy or a scratch database first (tests use temporary ones; `--database` points the app elsewhere, and `LOCALAPPDATA`/`HOME` move the whole data folder).
- Releases go through pull requests into `main` (see README → Releases). Raise the version (`npm version patch|minor|major --no-git-tag-version`) for a release, or label the PR `no-release`. Don't push unless asked.
- Line endings are LF everywhere (`.gitattributes`, `.editorconfig`).

## Conventions

- Edit files with an editor tool, not `sed`, heredocs or inline scripts; write multi-step shell work to a script file and run that (Windows PowerShell 5.1 mangles quotes in arguments to programs). Commit messages go in a file: `git commit -F <file>`.
- Comments say why, in plain words; names are spelled out (`journalDirectories`, not `dirs`).
- Tests (`test/*.test.mjs`) drive the real ingester and stats engine through `test/helpers/journal-fixture.mjs`. New behaviour gets a test; things only a built executable does get covered by `scripts/smoke-test.mjs` (run by CI on Windows and Linux).
- A request's local/remote split (`src/server/auth.mjs` `isLocalRequest`) decides what needs the password and what's shown as "this computer".

## Layout

| Path | What |
| --- | --- |
| `src/journals/` | Finding journal folders, reading journals (ingester), watching them (monitor), Status.json |
| `src/stats/` | Stats engine and the stat modules (`modules/`, listed in `index.mjs`) |
| `src/database/` | Schema, migrations, entry compression, statistics and reset |
| `src/server/` | Express app, auth, routes |
| `src/settings/` | `settings.json` (settings and the password hash) |
| `src/windows/` | Tray icon, running in the background |
| `client/src/` | Dashboard: `App.jsx` (pages, banners), `hooks/use-api.js` (requests, caching, live refresh), `pages/` |
| `scripts/` | Bundling, packaging, Linux installer, CI helpers (version check, release notes, smoke test) |
| `.github/` | Workflows (checks, version, build, release), ruleset, Dependabot |
