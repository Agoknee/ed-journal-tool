# ED Journal Tool

Watches Elite Dangerous journal files, stores every entry in SQLite, parses stats into their own tables, and serves a REST API plus a React dashboard.

Journal files are only ever opened read-only.

## Important: Please Read!

This tool is 100% vibe-coded by Claude. It's something I've been wanting to build for months, but never found the time for. It's built using the technology I wanted and in the structure I had always envisioned, but the code is almost entirely written by Claude. The people that deserve all credit for this are the authors of existing Elite Dangerous tools. These developers have spent countless hours reverse-engineering the Elite Dangerous journal file format and figuring out various tricks to parse out the desired data. This tool (and the many other AI-generated journal tools being built) would not be possible without the hard work of those developers. Please check out and support their projects! Some specific call-outs:
- [Elite Dangerous Carrier Manager (EDCM)](https://www.edcm.app/) -- If you have a fleet carrier, you want this tool. It is incredibly useful with many excellent features and runs well along-side EDJT. This code was analyzed to help determine carrier tracking and game-server clock synchronization.
- [Pab's AFK Monitor](https://github.com/PsiPab/ED-AFK-Monitor) -- If you run AFK stacks (or other Wing Massacre Missions), this tool is very helpful. This code was analyzed to help with the combat panel, shown while an AFK stack is active. EDJT will also soon have a button to automatically launch AFK Monitor against the matching journal file for an active commander.
- [BGS-Tally](https://github.com/v-tolagh/BGS-Tally) -- The code from this EDMC plugin was used to build the BGS Reporting functionality.
- [Spansh](https://www.spansh.co.uk/) -- Spansh contains invaluable Elite Dangerous data, including many powerful route plotting tools. EDJT integrates with these plotters.
- [Wanderer's Toolbox](https://wanderer-toolbox.com/useful-tools/multi-waypoint/) -- The Wanderer's Toolbox contains several well-written guides and some useful tools. EDJT integrates with the multi-waypoint tool.
- [Inara](https://inara.cz/elite/) -- Elite Dangerous would simply be unplayable without the incredible Inara website/database. Some rank, powerplay, and material icons shown in EDJT come from Inara.

## Features

- **Stats, stats, and more stats (with more to come).** Commanders (fleet, inventory, ranks and reputation, credits, engineers), fleet carriers (details, jump history, bank history), travel, trade and markets, carrier depots, BGS activity, missions, combat and chat, across every commander in your journals.
- **Massacre stacks.** Tracks AFK massacre stacks like OD Elite Tracker or EDMT: missions grouped by target, the kills the stack needs (as many as its largest faction asks for), progress for each faction, and the rewards. Wing mining missions (WMM) are tracked under Missions → Mining & Cargo too, but haven't been tested yet. Plans to add a button to auto-launch Pab's AFK monitor matched to the correct journal file.
- **A live combat panel** for AFK sessions: kills and kill rate, time since the last kill, the time left to finish the stack, and warnings for your fighter (destroyed, rebuilt, or not deployed), shields, hull, hardpoints and fuel (including whether it lasts until the stack is done).
- **Combat history:** every session, kill, death and interdiction, with kills over time, when you fight, and who you fought.
- **BGS reports like BGS-Tally.** Activity per system and faction, with a button that copies a Discord-ready message in BGS-Tally's ANSI format, for one commander or all of them combined. It reads the journals themselves, so nothing is missed: it doesn't matter which games were launched in which order, or whether EDJT was running at the time. Activity the journals don't record can be added as manual adjustments.
- **BGS tick tracking,** with a tick history, and a warning when your PC's clock is off from the game server's (which throws off carrier jump and cooldown timers).
- **One-click route planning.** Opens Spansh's Galaxy Plotter with a ship's build (SLEF) and its current system filled in; the Fleet Carrier Router with your carrier's system, type and used capacity; or the Wanderer's Toolbox Multi Waypoint Planner at its import dialog, which optimizes the route as soon as you paste a list of systems. (These need a userscript, which the dashboard offers to install.)
- **Ship builds** exported as EDSY and Coriolis links, or SLEF to copy.
- **Notes** on any carrier or commander.
- **Finds your journals by itself:** the usual Windows folder, or on Linux Steam/Proton, Heroic, Lutris, Bottles and Wine folders. It can read several journal folders at once (one synced from another PC, say), and if none is found yet it keeps looking.
- **Keeps every journal entry** in its database (compressed), so the original journal files can be deleted once they've been read.
- **Use it from any device on your network,** phones included: the dashboard is a web page served on port 4267 (monitoring AFK sessions from your phone is amazing).
- **The Windows tray icon** opens the dashboard, shows the log, or quits. The Windows EXE runs in the background with no console window.
- **Windows and Linux.** The Linux installer adds a menu entry, and can run EDJT as a service so it keeps running in the background. That should let it work on a Steam Deck in Game Mode as well as Desktop Mode, but it hasn't been tried on one yet.
- **Journal details and raw SQL.** Click "X active journals" at the bottom left for every journal file and its status (including corrupt or unreadable ones), the raw lines of any journal, and a tool for running read-only SQL queries on all the stored data.

## Installation

Downloads are on the [Releases](https://github.com/Agoknee/ed-journal-tool/releases) page.

The Windows `.exe` is standalone and can run from any directory. When launched, it will minimize to the system tray (unless disabled via CLI parameters).

The Linux installer `.sh` is a self-extracting shell script, which will install the application for the current user and add it to the launch menu.
- If the installer is run with the `--service` parameter, the application will be installed as a user service. Running the application from the launch menu will open the web interface.
  - Running as a service is needed on Steam Deck, to allow it to continue running in both Game and Desktop modes.
- Running a new version of the installer will upgrade an existing installation.

### Options

| Option | Default | Description |
| --- | --- | --- |
| `-p, --port` | `4267` | Web server port |
| `-b, --bind` | `0.0.0.0` | Host/IP to bind (all interfaces by default) |
| `-d, --debug` | `false` | Verbose logging |
| `-j, --journaldir` | Found automatically | The journal folder. Windows: `%USERPROFILE%\Saved Games\Frontier Developments\Elite Dangerous`. Linux: searched for in Steam/Proton (including Flatpak and Snap Steam), Heroic, Lutris, Bottles and Wine folders, and looked for again every minute until found. Repeat it (`-j A -j B`), or separate folders with `;` (or `:` on Linux), to read several at once |
| `--database` | `%LOCALAPPDATA%\edjt\journals.db` (`~/.local/share/edjt/journals.db` on Linux) | SQLite database path |
| `--rebuild-stats` | `false` | Clear and rebuild all stats from stored entries on launch |
| `--no-download-images` | | Don't download the rank, Powerplay and engineer images from Inara (downloaded on first run, and whenever some are missing) |
| `--no-tray` | | Windows: no system tray icon (shown by default) |
| `--console` | `false` | Windows executable: stay in the console window instead of running in the background with only the tray icon |
| `--log-file` | | Windows: the file this run's output is redirected to, for the tray icon's "Show Log" (the background exe uses `%LOCALAPPDATA%\edjt\edjt.log` by itself) |
| `--dev-client` | `false` | Serve the dashboard from client source with Vite (hot reload); used by `npm start` |
| `-h, --help` / `-v, --version` | | Show the options / the version |

## Developer Setup

```sh
npm install
npm run client:install
npm run build          # builds the dashboard into client/dist
npm start              # serves the dashboard from source with Vite (hot reload)
npm run start:built    # serves the built dashboard from client/dist (run npm run build first)
npm run debug          # same as npm start, with verbose logging (npm run debug:built for the built dashboard)
npm run dist           # builds dist/ed-journal-tool-<version> (Linux) and .exe (Windows), client included
```

Then open http://localhost:4267.

### Client development

`npm start` runs Vite inside the server, so the dashboard and API share port 4267 with hot reload. Alternatively, run `npm run start:built` and `npm run client:dev` for a standalone Vite server that proxies `/api` to port 4267 (set `API_SERVER_URL` to change that).

### Standalone executables

`npm run dist` writes to `dist/`:

- `ed-journal-tool-<version>.exe` (Windows), with the app icon and version details (from `packaging/edjt.ico` and `package.json`).
- `ed-journal-tool-<version>` (Linux), and `ed-journal-tool-<version>-linux-x64-install.sh`, which installs it for the current user with its icon and a menu entry (`sh ed-journal-tool-<version>-linux-x64-install.sh --help` for its options).

### Releases

`main` only changes through pull requests, which have to pass two required checks:

- **Version raised** (`.github/workflows/version.yml`): the version in `package.json` is higher than the last release's (raise it with `npm version patch`, `minor` or `major`), unless the pull request is labelled `no-release`. It's the only check that runs again when labels change.
- **Checks passed** (`.github/workflows/checks.yml`): lint, the tests on Windows and Linux, and the build (`.github/workflows/build.yml`): `npm run dist`, then each executable is started and its API and dashboard checked (`scripts/smoke-test.mjs`), the Linux one also through its installer, and the Windows one on Windows. The files can be downloaded from the run's Artifacts.

Any branch can be built by hand: Actions → Build → Run workflow, choosing the branch. Its version has the commit added (`0.2.0+abc1234`, in the file names and in the app), so it can't be mistaken for a release; untick "Add the commit to the version" to build with the plain version.

Each merge into `main` not labelled `no-release` is released by `.github/workflows/release.yml`, as a **draft**: the executables, their checksums and a [provenance attestation](https://docs.github.com/actions/security-for-github-actions/using-artifact-attestations), with the commits since the last release. Publish the draft on the Releases page; that creates the `v<version>` tag. Until then, a later merge with the same version replaces the draft. A version with a suffix (`1.2.0-beta.1`) is marked as a prerelease. Anyone can check a download was built by this workflow with `gh attestation verify <file> --repo <owner>/ed-journal-tool`.

Dependabot (`.github/dependabot.yml`) opens weekly pull requests for package and action updates, labelled `no-release`. The workflows' actions are pinned to commits, which Dependabot moves along.

Setting up the repository, once:

1. Import the branch rules, `.github/rulesets/main.json`: Settings → Rules → Rulesets → New ruleset → Import a ruleset. (It requires both "Checks passed" and "Version raised".)
2. Create the labels: `gh label create no-release --description "Merged without a release" --color cccccc` (`dependencies` too, if it isn't there).
3. Settings → Actions → General: tick "Require actions to be pinned to a full-length commit SHA", so an unpinned action can't be added.

## How it works

```
journal files ──▶ JournalIngester ──▶ journal_files / journal_entries / commanders
      ▲                                        │
 chokidar + polling (JournalMonitor)           ▼
                                   StatsEngine ──▶ stat module tables ──▶ /api/stats/<module>
                                                         │
                                          EventHub ──▶ /api/events (SSE) ──▶ dashboard refresh
```

- **Ingestion** (`src/journals`): each file's byte offset is stored, so only new data is read, both on launch and while running. A line without a trailing newline, or one that fails to parse, is left for a later retry because the game may still be writing it. After 5 retries, or once a file hasn't changed for 2 minutes, unparseable lines are skipped and counted.
- **Commander assignment**: a file is linked to the commander found in its `Commander`/`LoadGame` events. A file with no commander once it's finished, or with more than one commander, is flagged `corrupt`: its entries aren't stored and it shows in the Journals section with the reason. A file that's still being written and has no commander yet is `pending`.
- **Active journals**: an unclosed file (no `Shutdown`/`Continued`), modified within the last hour, that is the newest file for its commander. chokidar catches new files and changes, and active files are also polled every 2 seconds because Windows can delay change notifications for open files.
- **Stats** (`src/stats`): each module keeps a cursor (the last entry id it processed), so updates only touch new entries.

## Adding or removing a stat

1. Create `src/stats/modules/my-stat.mjs` with `defineStatModule({ name, version, events, schemaSql, ownedObjects, createProcessor, createRouter })`. See the existing modules; `fuel-deposits.mjs` is the smallest.
2. Add it to the list in `src/stats/index.mjs`.

On the next launch, a new module processes all stored entries. Bumping `version` rebuilds it from scratch. Removing a module from the list drops its tables. Its API is mounted at `/api/stats/<name>`.

## API overview

| Route | Description |
| --- | --- |
| `GET /api/status` | Scan progress, module status |
| `GET /api/commanders` | Commander list |
| `GET /api/journals`, `/api/journals/summary`, `/api/journals/:id/entries` | Journal files, counts, active files, raw entries |
| `POST /api/sql` `{ query }` | Raw SQL on a read-only connection (max 1000 rows); `GET /api/sql/schema` |
| `GET /api/events` | Server-sent events: `journals`, `stats`, `scan` |
| `GET /api/stats` / `POST /api/stats/rebuild` `{ module? }` | List or rebuild stat modules |
| `/api/stats/commanders` | Profiles, ranks, ship, game mode |
| `/api/stats/travel/{locations,summary,jumps,top-systems}` | Location; normal / supercharged / synthesis / carrier jumps |
| `/api/stats/assets`, `/api/stats/assets/:commanderId` | Credits, fleet, modules, materials, locker, cargo |
| `/api/stats/carriers`, `/jumps`, `/transactions` | FC/SFC details and history, commander carrier status |
| `/api/stats/commodities/{trades,totals,list}` | Commodity purchase/sale history and totals |
| `/api/stats/fuel-deposits/{deposits,totals}` | Carrier depot tritium deposits |
| `/api/stats/markets` | Known stations/carriers (resolves market ids to names) |

Most list endpoints accept `commander=<id|all>`, `search=`, `period=24h|7d|30d|90d|1y` or `from=`/`to=`, `sort=`, `order=asc|desc`, `limit=` and `offset=`.
