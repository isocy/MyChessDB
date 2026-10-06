# My Chess DB online

This is the public version of My Chess DB. The original local app (`app.py`,
`index.html`, `start.bat`, `saved_positions.json`) is untouched and still works
on its own; everything described here lives in new files and folders.

## How it works

| Part | Where it runs | What it does | Files |
|---|---|---|---|
| Site | Cloudflare (static files) | Board, notation, opening names | `web/` |
| API | Cloudflare Worker + D1 database | Shared best-move database and its rules | `worker/`, `migrations/` |
| Engine bridge | Each user's own computer | Runs the official Stockfish 19 natively for the site | `bridge/`, built into `web/bridge/` |

Anyone can open the site and see saved best moves. To analyse with Stockfish, a
user installs the engine bridge once with a single terminal command shown on
the site. The bridge downloads the official Stockfish 19 for that computer
from the Stockfish project's GitHub release, checks it against SHA-256 values
built into the bridge, and runs it locally. No engine work happens in the
cloud or in the browser.

### Who can save what

There are no accounts. Trust comes from where an entry came from:

- **Lichess entries** are fetched from Lichess by the server itself, so the
  browser cannot fake them. They count as verified.
- **Stockfish entries saved with a key** (your admin token, or a contributor
  key you created for someone) count as verified.
- **Stockfish entries without a key** are stored as *unverified* and shown with
  that mark. A depth reported by someone's own computer cannot be checked.

A verified entry is never replaced by an unverified one. Within the same tier
only a strictly deeper analysis replaces the stored one. Everyone except the
admin must reach depth 46. Whatever gets replaced or removed is copied to a
history table first and can be restored from the admin tools.

## Deploy to Cloudflare (free plan)

You need a free Cloudflare account and [Node.js](https://nodejs.org) 22 or
newer on your PC. Run these in the project folder:

```powershell
npm install
npx wrangler login
npx wrangler d1 create mychessdb
```

The last command prints a `database_id`. Paste it into `wrangler.jsonc` in
place of `PASTE-THE-DATABASE-ID-HERE` (wrangler may offer to do this for you).
Then:

```powershell
npx wrangler d1 migrations apply mychessdb --remote
npx wrangler deploy
npx wrangler secret put ADMIN_TOKEN
```

`deploy` prints the site address, something like
`https://mychessdb.<your-subdomain>.workers.dev`. For `ADMIN_TOKEN` enter a
long secret (at least 16 characters); the contents of your existing
`admin_token.txt` will do. Keep it private: it is the admin login.

Then, on the site:

1. Paste the admin token into the key field and click **Login**.
2. Open **Position and engine settings**, click **Import saved_positions.json
   or backup**, and choose your `saved_positions.json`. All entries are stored
   as verified. Importing the same file twice changes nothing.
3. Click **Connect** under the analyse button and follow the instructions to
   install the bridge on your own PC.

To publish a change later, run `npx wrangler deploy` again.

### Using your own domain

Add the domain in the Cloudflare dashboard (Workers & Pages, your Worker,
Settings, Domains & Routes). The install command on the site always uses the
address the visitor is on, and each bridge only obeys the site address it was
installed from, so users who installed from the `workers.dev` address need to
run the install command again from the new address.

## What users do

1. Open the site in Chrome, Edge or Firefox. (Safari can show saved moves but
   blocks secure pages from talking to local programs, so it cannot analyse.)
2. Click **Connect**, copy the command for their system, paste it into a
   terminal:
   - Windows: PowerShell
   - macOS / Linux: Terminal
3. The bridge starts, downloads Stockfish 19 (about 80 MB) and the site shows
   "Stockfish 19 ready". The browser asks once whether the site may access
   other apps and services on the device; they choose Allow.

The installer adds a "My Chess DB Bridge" launcher (Start menu shortcut on
Windows, Applications entry on macOS and Linux) for next time; the site also
shows a short start command. The bridge's window has to stay open while
analysing.

Nothing is installed system-wide and no administrator rights are needed.
Because the files are fetched by a terminal command instead of being
double-clicked from a download, Windows SmartScreen and macOS Gatekeeper do
not prompt.

Where things go, and how to remove them:

| System | Bridge | Stockfish and settings |
|---|---|---|
| Windows | `%LOCALAPPDATA%\MyChessDB` | `%APPDATA%\MyChessDB` |
| macOS | `~/.mychessdb` | `~/Library/Application Support/MyChessDB` |
| Linux | `~/.mychessdb` | `~/.config/MyChessDB` |

Deleting those folders and the launcher uninstalls it.

## Admin tools

Log in with the admin token, then open **Position and engine settings**:

- **Analysis depth**: only you can change it; it resets to 46 on each visit.
- **Remove saved move**: removes the entry for the position on the board. It
  stays in the history.
- **History of this position**: every replaced or removed entry, each with a
  **Restore** button.
- **Contributor keys**: create a key for someone you trust; it is shown once.
  Their Stockfish results are then saved as verified. **Revoke** stops the
  key; **Revoke + unverify entries** also marks everything saved with it as
  unverified, so it can be replaced.
- **Download backup**: the whole database, including history, as one JSON
  file. The same file can be imported again.

Settings you can change in `wrangler.jsonc` under `vars`: `MIN_DEPTH`
(default 46) and `ANON_WRITES_PER_HOUR` (default 60 save attempts per hour for
a visitor without a key).

## Free plan limits to know about

- 100,000 API requests per day; static files do not count.
- D1: 5 million rows read and 100,000 rows written per day, 5 GB storage.
  Opening the site reads every saved position once, so with 500 entries that
  is about 10,000 page loads a day.
- When a daily limit is hit, the API returns errors until 00:00 UTC.

## Development

```powershell
npm run dev          # http://localhost:8787, local SQLite file, no Cloudflare needed
npm test             # chess rules + API rules
```

`npm run dev` prints a development admin token. To use the bridge with the
local site, start it with `-site http://localhost:8787`.

More tests (need [Go](https://go.dev/dl/) 1.22+):

```sh
npm run test:bridge              # bridge with a stand-in engine (Linux or macOS)
node tests/e2e.mjs               # whole system in Chromium (Linux x86-64, needs Playwright)
node tests/e2e_real.mjs          # same with the real Stockfish 19 download
```

`tests/make_chess_fixture.py` regenerates the python-chess reference data the
chess-rules test can cross-check against (optional; the file is large and not
kept in the repository).

### Rebuilding the bridge

`web/bridge/` holds the bridge for Windows, macOS and Linux (x86-64 and ARM64)
plus `SHA256SUMS`. To rebuild after changing `bridge/*.go`, install Go and run
`scripts\build_bridge.ps1` (Windows) or `sh scripts/build_bridge.sh`, then
deploy. Builds are reproducible: the same Go version gives byte-identical
files. The current ones were built with Go 1.24.7.

If you deploy from another copy of the repository, make sure `web/bridge/` is
there (commit it, or build it), otherwise the install command has nothing to
download.

### When a new Stockfish version comes out

The bridge only runs executables whose SHA-256 is listed in
`bridge/engine.go` (`pinnedEngines`) and only downloads release files listed
in `bridge/install.go` (`pinnedArchives`, `stockfishTag`). For a new release,
download its files from the official GitHub release, compute their SHA-256,
update those tables and `engineVersionName`, bump `version` in
`bridge/main.go`, rebuild and deploy. Users then run the install command once
more.

## What has and has not been run for real

Tested here, on Linux, in a real browser:

- chess rules against published perft counts and 28,694 positions from
  python-chess; opening table identical to the old `app.py` logic
- every API rule against SQLite (the engine behind D1)
- the released Linux bridge downloading the official Stockfish 19 from GitHub,
  analysing, pausing, resuming, stopping, and cleaning up
- the macOS/Linux install script
- importing your real `saved_positions.json` (492 entries, none skipped)

Not yet run on the real thing:

- the Cloudflare deploy itself (wrangler, real D1, the `_headers` file)
- the bridge and `install.ps1` on Windows, and the bridge on macOS. They
  compile and share the tested code, but the Windows-only parts (pause through
  `NtSuspendProcess`, the kill-on-close job, the Start menu shortcut) and the
  macOS memory lookup have not executed anywhere yet.
- the browser's "allow this site to reach apps on your device" prompt, which
  only appears on a real `https://` address
- Lichess from Cloudflare's network (the server-side check of Lichess entries
  was tested against a stand-in)

## Credits

Opening names: [lichess-org/chess-openings](https://github.com/lichess-org/chess-openings), CC0.
Engine: [Stockfish](https://stockfishchess.org), GPLv3, downloaded by each
user from the official release; it is not redistributed by this site.
