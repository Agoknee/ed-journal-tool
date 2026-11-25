# Decisions

Why EDJT is built the way it is: one entry per decision that spans files, or that would otherwise be undone. Newest areas last. Each says what was decided, why, and where it lives.

## Storage

### Every journal entry is kept, compressed
The database stores every journal line, not just what the stats need, so new stats can be built from history and journal files can be deleted once read. Lines are deflated against a dictionary trained on the user's own entries (`src/database/entry-compression.mjs`); each rewritten entry is checked to decompress exactly before it's saved. A new database gets its dictionary after the first scan, once there are enough entries.

### Settings live in `settings.json`, not the database
`src/settings/settings-store.mjs`. The dashboard's SQL tool can read every table, which would expose the password hash, and deleting `journals.db` to start afresh shouldn't lose settings. New settings are added to `SETTING_DEFINITIONS` (default + check); the app's own values (password hash, session key) are kept apart and never sent to the client.

### The data folder is created at startup
On a new system nothing else creates `%LOCALAPPDATA%\edjt` before the first write (the background exe's log came first and failed). `ensureDataDirectory()` runs before anything else; the smoke test runs each executable against a data folder that doesn't exist yet so this can't regress.

### Resetting the database is done in place
`createDatabaseReset` in `src/app.mjs`, `src/database/database-maintenance.mjs`. EDJT can't restart itself in every mode it runs in (console, background with the tray, systemd service), so a reset pauses what uses the database (the journal watcher finishes any file it's reading), empties every table and shrinks the file, forgets what was remembered of the old data (stat processors, Status.json's commanders, and every connection's compression dictionaries — the SQL tool's would otherwise decode new entries with the old one), then reads the journals again. By default a copy is kept first (`VACUUM INTO`, after checking for disk space); if it can't be made, nothing is deleted. Strong confirmation (typed `RESET`, the password from other devices); refused while scanning, building or compressing.

## Access

### The password is only for other devices
`src/server/auth.mjs`. On the computer running EDJT nothing is asked; with no password set, other devices can't use it at all. "Local" means arriving over loopback *and* addressed to `localhost`/`127.0.0.1`/`[::1]`, so a web page can't pass as local by pointing a name at 127.0.0.1 (DNS rebinding). scrypt hash; 30-day HttpOnly SameSite=Strict cookie signed with a key that changes with the password (changing it logs every device out); 5 wrong passwords lock an address out for a minute; non-GET requests from other origins are refused.

### Plain HTTP, for now
The password crosses the network unencrypted, and browsers won't install a PWA or run a service worker except over HTTPS (or on localhost). Open: whether EDJT generates its own certificate authority (installed once per phone), takes a certificate the user provides (mkcert, Tailscale), or both. Plain self-signed certificates don't work: service workers refuse them even after clicking through.

## Running on Windows and Linux

### Journal folders are found unless given
`src/journals/journal-locations.mjs`, `watchForJournalFolders` in `src/app.mjs`. Without `-j`/`--journaldir`, the usual places are searched: one on Windows; on Linux, where the game runs under Proton or Wine in many possible places, Steam libraries from `libraryfolders.vdf`, Flatpak and Snap Steam, Heroic, Lutris, Bottles and Wine prefixes. `-j` (repeatable, which the Linux installer passes on) gives the folders instead, and nothing is searched.

When no folder is there at startup, the app starts anyway, says so on the dashboard, and checks every minute (searching again, or with `-j`, checking the given folders) until one is found; then it reads them and stops checking. Once a folder has been found, nothing more is searched: a journal folder appearing later elsewhere (another Steam library) needs a restart.

Separately, every minute for as long as the app runs, it checks that each journal folder it reads is there (`watchForReturningFolders`): a `-j` folder missing at startup while another is there, or a synced folder that was unavailable, gets the file watcher pointed at it again once it appears, and is read (the watcher doesn't notice a folder appearing where there was none). Such a folder stays in the list meanwhile, unreadable, so the journals stored from it aren't marked missing.

### The Windows exe runs in the background with a tray icon
`src/windows/background.mjs`, `tray.mjs`. Started normally it starts a hidden copy of itself (logging to the data folder) and exits once that's up, so no console window stays open; `--console` keeps it in the console. A packaged exe started from itself runs as plain node, so it's given its entry script first.

### The tray icon is a small program of its own
Windows names a tray icon after the program showing it; a hidden PowerShell would be listed as "Windows PowerShell". So a tiny C# program (`tray.cs.mjs`) is compiled once with the C# compiler every Windows 10/11 has (.NET Framework 4), into the data folder at a fixed path (Windows remembers a tray icon's settings by path). If that fails, PowerShell shows the icon instead.

### Linux: a self-extracting installer, and an optional service
`scripts/linux-installer.sh` (a real shell script with placeholders, so it isn't quoted inside JavaScript). Installs for the user (no root) with a menu entry. `--service` runs it as a systemd user service, the way to keep it running on a Steam Deck in Game Mode; the installer suggests lingering then.

## CI and releases

### Release on merge, as a draft
`.github/workflows/release.yml`. GitHub won't let you approve your own PR, so "on approval" would never fire on a one-person repo; merging is the go-ahead. The release is a draft (executables, checksums, provenance attestation, commits since the last tag); publishing it creates the tag. A later merge with the same version replaces the draft.

### `no-release` instead of always raising the version
Documentation, CI and dependency PRs needn't make a release. They're labelled `no-release` (Dependabot's are, by config): the version check passes and merging releases nothing. Note the version check compares against the highest `v*` **tag**, i.e. the last *published* release — drafts have no tag.

### The version check is its own workflow
`.github/workflows/version.yml`. A PR opened with a label started two Checks runs at once, and the cancelled one reported "Checks passed" as failed. Now only this small workflow reruns on label changes; it reads the labels when it runs (not from the event), and its runs aren't cancelled. The ruleset requires both "Checks passed" and "Version raised".

### One build workflow for checks, releases and manual builds
`.github/workflows/build.yml` is called by the PR checks and the release, and can be run by hand for any branch (then the version gets the commit added, `0.4.0+abc1234`, so it can't pass for a release). It runs `npm run dist`, then the smoke test on each executable as on a new system, the Linux one also through its installer, and the Windows one in its console and in the background.

### Actions pinned to commits
Tags like `@v4` can be moved by whoever controls the action (as happened to tj-actions/changed-files), and the release job can write releases. Every action is pinned to a full commit SHA with the version in a comment; Dependabot moves the pins.

## Dashboard

### Progress is shown for every long step
Scanning, building stats and compressing entries each have a banner, from `scan`, `statsBuild` and `compression` updates (also in `/api/status` for a page opened midway), sent at most every second. Small stats updates while playing aren't shown, so nothing flickers.

### Requests share results and refresh by topic
`client/src/hooks/use-api.js`. Components asking for the same thing share one request for a few seconds. Each request names the live-update topics it refreshes on; the server announces changes per topic (and per stat module), so only what changed refetches. The shared result's key includes the topic **names** as well as their counts: keyed by counts alone, the clock warning (refreshing on `clock`) was handed a status the scan banner (on `scan`) had fetched before the clock was checked.

### Reconnecting refetches everything
`client/src/hooks/LiveUpdatesProvider.jsx`. Whatever the server announced while the live updates were down (a restart, typically) was missed, so a reconnect bumps a counter every request includes, and drops progress from before. The browser gives up on a stream that gets an answer other than the stream; then it's opened anew after a few seconds (and the login checked again, so a device whose session ended gets the login screen rather than endless retries).

### While EDJT can't be reached, keep what's on screen
`client/src/api.js`, `hooks/use-api.js`, `components/ui.jsx`. Once the stream has been down for 4 seconds (a restart takes about that) `isUnreachable` turns on, and the banner, the sidebar status, the sections and the tables all go by it. Requests that fail because EDJT doesn't answer throw `UnreachableError`; sections keep the data they had and the banner explains, sections without any say "Not loaded yet" (including ones waiting on another request's answer, which never start). The last response per URL is kept in memory (8 MB of JSON, least recently fetched first) so a page opened again shows its data at once. Not kept in IndexedDB: it works over plain HTTP, but with EDJT down the page itself can't load to read it — that needs a service worker, so HTTPS (see Access). Open the pages you'll want before EDJT goes away.

### The galaxy map replays on the graphics card
`client/src/pages/travel/galaxy-scene.js`, `src/stats/modules/travel.mjs` (`/map`). three.js, loaded only when the map is opened (it's about 600 KB). Each jump is one line segment whose vertices carry the timeline position they're reached at; the shaders hide what's in the future, so replaying or scrubbing moves one uniform instead of rebuilding geometry, and 250,000 jumps stay smooth. Each jump stores where it started (`from_star_pos`), so a filtered list (supercharged only, say) still draws each jump in the right place rather than joining unrelated systems. The map's response lists each system once and the jumps point at them. The galaxy is procedural (seeded, so it's the same every time) in the game's coordinates, not an image of the game's map.

### The clock can't be synced from EDJT
On Windows a normal user can't start the time service, run `w32tm /resync` or the sync task; on Linux syncing needs polkit authorisation, which a service can't prompt for (and a Steam Deck has no password by default). So the clock warning links to Windows' Date & Time settings ("Sync now" needs no admin) on the Windows computer itself, and says "the EDJT computer" on other devices.
