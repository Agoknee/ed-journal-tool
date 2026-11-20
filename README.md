# ED Journal Tool

Watches Elite Dangerous journal files, stores every entry in SQLite (`node:sqlite`), parses stats into their own tables, and serves an API (`/api`) plus a React dashboard.

Journal files are only ever opened read-only.

## Setup

```sh
npm install
npm run client:install
npm run build          # builds the dashboard into client/dist
npm start              # or: node src/index.mjs --help
```

Then open http://localhost:4267.

### Options

| Option | Default | Description |
| --- | --- | --- |
| `-p, --port` | `4267` | Web server port |
| `-b, --bind` | `0.0.0.0` | Host/IP to bind (all interfaces by default) |
| `-d, --debug` | `false` | Verbose logging |
| `-j, --journaldir` | `%USERPROFILE%/Saved Games/Frontier Developments/Elite Dangerous` | Journal directory |
| `--database` | `data/journals.db` | SQLite database path |
| `--rebuild-stats` | `false` | Clear and rebuild all stats from stored entries |

### Client development

Run the server, then `npm run client:dev` for Vite with hot reload (it proxies `/api` to port 4267; set `API_SERVER_URL` to change that).

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
