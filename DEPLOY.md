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

### Engines and views

Results are kept per engine: a position can have a **Stockfish 19** entry and
a **Lichess** entry, and neither replaces the other. **Results shown** above
the analyse button chooses what is on screen, and what the button does:

| View | Shows | The button |
|---|---|---|
| Combined (first visit) | for each position the deeper of the two; Stockfish 19 when they are equally deep | **Find and save best move** does both at the same time: fetches Lichess's evaluation and runs Stockfish through the bridge; each is saved under its own engine, and **Stop analysis** stops both |
| Stockfish 19 | Stockfish 19 entries only | **Find and save best move** runs Stockfish through the bridge; Lichess is not asked |
| Lichess | Lichess entries only | **Get Lichess evaluation** fetches the evaluation Lichess has stored and saves it |

The choice is remembered in the browser. The depth line always names the
engine ("Stockfish 19 · Depth 46", "Lichess · Depth 50 | 1234k nodes").

What is saved for a position is fetched when the position is shown, one small
request per position, so the size of the database does not matter to the
page.

### Who can save what

There are no accounts. Trust comes from where an entry came from:

- **Lichess entries** are fetched from Lichess by the server itself, so the
  browser cannot fake them. They count as verified, with or without a key.
  Both the page and the server ask Lichess for one line (`multiPv=1`):
  Lichess answers with its deepest evaluation that has at least the number of
  lines asked for, and its deepest ones are mostly single-line.
- **Stockfish entries saved with a key** (your admin token, or a contributor
  key you created for someone) count as verified. Under the key field the
  page tells visitors who know you to contact you for a key (no address is
  shown: those who know you have it), and that it also keeps their puzzles
  on the server.
- **Stockfish entries without a key** are stored as *unverified* and shown with
  that mark. A depth reported by someone's own computer cannot be checked.

Among the entries of one engine, a verified one is never replaced by an
unverified one, and within the same tier only a strictly deeper analysis
replaces the stored one. Whatever gets replaced or removed is copied to a
history table first and can be restored from the admin tools, with two
exceptions that keep the history small: an entry replaced by a deeper one
from the same saver (the same key, or the same network without a key, as live
analysis does every 30 seconds) is not kept, since it is never the one to go
back to; and per position and engine only the newest 50 unverified entries
are kept (verified ones always are).

### Depth

The least depth is 21. Nothing shallower is saved, for anyone, the admin
included, from either engine, and the **Stockfish analysis depth** field does
not take less (it corrects itself to 21). A Lichess evaluation below depth 21
is shown while its line stays in the list, but not saved. The only exception
is the admin's import, so that a backup is restored exactly as it was.

From depth 21 on, anyone can choose the analysis depth (it starts at 46 on
every visit), and an analysis that is stopped early is saved as far as it got:
stopped while Stockfish is searching depth 40, the result of depth 39 is
saved. Nothing is saved if the depth it had finished is below 21, or if what
is already stored would not be replaced by it.

Depth 46 is the *full depth*. The best move of an analysis at depth 46 or more
is painted in the full green. Below that the green is much paler, and paler
still the shallower the analysis, so depth 45 cannot be mistaken for depth 46.

While Stockfish runs, the page follows it: the best move on the board, the
evaluation, the depth and the line are those of the depth it finished last,
and the bar left of the board shows the evaluation (White's share from White's
side of the board). If the position already has a saved analysis that is
deeper than what the running one has reached, the saved one stays on screen
until the running one has passed it.

Both engines' evaluations are written the same way: in pawns from White's
side ("+0.32"), or "#3" / "#-3" for a forced mate. The numbers are not on
exactly the same scale, though. Stockfish 19 scales its score so that +1.00
means roughly even winning chances for the side ahead, and in clearly won
positions its numbers grow quickly (+5.56 where Lichess says +3.58 is
typical). Lichess's evaluations were made by many visitors' browsers with
many Stockfish versions over the years, some of them before that scaling.
Where the two disagree by more than that, it is usually a difference in depth
or a sharp position; the sign and the side are the same for both. (Lichess
entries saved before this notation was shared read "Lichess Cloud: +0.25" in
the database; they are shown in the shared notation.)

When a position is shown, the page also fetches what is stored for every
position one legal move away (`GET /api/position?fen=...&next=1`, one request,
at most a few hundred rows read), so a move shows its result at once.
When a position is loaded together with the moves that led to it (from the
list of analyses), what is stored for those earlier positions comes in one
more request (`&also=...`, up to 100 positions per request), so going back
through the moves shows their results at once. A live analysis result is not
shown for a position until what is stored for it is known, so it never
flashes purple before a deeper saved result.

### Live analysis

The position on the board is analysed while it is there, the way the Lichess
analysis board does it: the bridge runs Stockfish on it without a depth
limit, and the next move moves the search to the next position at once.
Whether or not an analysis is saved for the position, the page shows the
deeper of the two, the saved analysis or the live one. While the live one is
shown, its best move is painted purple, not green, and the depth line ends
in "live analysis". While the search goes on it stays purple also when it is
only as deep as the saved result, as right after it has been saved ("live
analysis, saved"); once the search stops (another position, the tab hidden,
live analysis turned off) that saved result is shown in green. Seen again
later, it is green like any saved analysis until the new search goes deeper.

- **Saving.** Once the live analysis is deeper than the position's saved
  Stockfish 19 analysis (or reaches depth 21 where none is saved), it is
  saved like an analysis from the button: verified with a key, unverified
  without, under the same rules (an unverified result never replaces a
  verified one; the depth line then ends in "not saved"). While the position
  stays on the board it is saved at most every 30 seconds; when the search
  leaves the position or stops (another move, the tab hidden, live analysis
  or the browser engine turned off, the page reloaded or closed) its deepest
  result is saved at once. For visitors without a key, live analysis may save at most
  500 times an hour (`ANON_LIVE_WRITES_PER_HOUR`) out of the 600 save
  attempts they have in all (`ANON_WRITES_PER_HOUR`), so at least 100 stay
  for analyses run with the button. When either limit is hit, live analysis
  stops saving until the next hour and keeps analysing.
- What was found is also kept while the page is open, so going back to a
  position shows it again at once, and the search carries on from there.
- It is not run for a position whose own analysis (from the button) is
  running, which is shown as before, or where the game is over.
- It is used in the Stockfish 19 view and in Combined (there it competes
  with Lichess's entry too: the deepest is shown). The Lichess view does not
  use it.
- **Live analysis: on/off** above the board, next to Flip board, turns it on and off.
  It is on until turned off; the choice is remembered in the browser. It needs
  the engine bridge 1.0.6 or newer (the site now asks for 1.0.8, which the
  puzzles need); without it the button's tooltip says why
  nothing happens. The tooltip also tells how the last save went.

The bridge keeps one Stockfish process for it, apart from the analysis
queue: it gets a share of the processor like one more running analysis (and
analyses started meanwhile count it), with a hash table of at most 1 GB. It
stops searching when the page has not asked for 10 seconds (the tab was
closed; a hidden tab stops it at once), and ends the process after another
minute. Only one position is searched at a time: when two tabs are open, the
one used last has it.

### Browser engine

Without the engine bridge, live analysis can run Stockfish 19 in the browser
instead, the way the Lichess analysis board does. It is offered under the
engine bridge's line ("No engine bridge? ... **Use browser engine**") and only
starts when asked, because the first time it downloads 99 MB (the browser
keeps the file afterwards). The offer says so, and that it is several times
slower than the bridge.

- It is live analysis exactly as described above: shown in purple, saved
  once deeper than the saved Stockfish 19 analysis, under the same limits.
  It is the same engine with the same networks as the bridge's
  ([stockfish.js](https://github.com/nmrugg/stockfish.js) 19.0.0, Stockfish 19
  built for WebAssembly), so its results are Stockfish 19 results.
- Analysing to a chosen depth (the analyse button) still needs the bridge.
- When the bridge is running, it does the live analysis and the browser
  engine rests; when the bridge goes away, the browser engine takes over.
  The browser engine closes after a minute without searching, giving its
  memory back.
- Threads: the site is cross-origin isolated (`Cross-Origin-Opener-Policy`
  and `Cross-Origin-Embedder-Policy: credentialless` in `web/_headers`), so
  in Chrome, Edge and Firefox it uses all processor cores but one (at most
  16). Where that is not possible (Safari, and browsers that cannot start a
  worker from a worker, which the page tests first) it uses one thread.
- The page checks the SHA-256 of what it downloaded against the values in
  `web/browserengine.js` and does not run anything else.

The two engine loaders (`web/engine/*.js`, 20-30 KB) are part of the site. The
two WebAssembly files, one for several threads and one for a single thread,
are 99 MB each, more than Cloudflare serves as static files (25 MB), so the
page takes them from the same npm package on unpkg
(`https://unpkg.com/stockfish@19.0.0/bin/`). unpkg answers from a nearby
Cloudflare cache (Seoul, for visitors in Korea: about 5 MB/s, some 20 seconds
for the whole file), while this site on `workers.dev` is answered from abroad
for them; serving the files from an R2 bucket through the Worker was tried
and gave about 0.2 MB/s in a browser. Nothing has to be set up for it; if
unpkg cannot be reached, the browser engine reports that it could not
download, and the engine bridge still works.

### Puzzles from your games

The second view of the page, **Puzzles from your games** (linked at the top
of the panel; the address ends in `#puzzles`), makes puzzles from a player's
own games: positions where one move was clearly better than every other and
the player missed it. Finding them needs nothing from this site's server: the
engine bridge (1.0.8 or newer) fetches the games from chess.com's and
Lichess's public APIs, analyses them with Stockfish 19 and finds the puzzles
on the player's computer, and the puzzles and how they were solved are kept
in the browser (IndexedDB). **Export** and **Import** under *Settings and
data* move them to another browser or device; a phone or tablet, which cannot
run the bridge, can solve puzzles found on a computer that way. Those with a
key keep them on the server too (below).

The two views are one page (`index.html`; the puzzle view's code,
`web/puzzles.js`, is loaded the first time it is shown). Switching between
them keeps each as it was, and an update of the puzzles goes on while the
best moves are shown; the browser's back and forward buttons switch too.
Live analysis only runs while the best moves are shown.

- **Accounts.** Enter a chess.com username, a Lichess username, or both,
  and click **Load**. The puzzles of both accounts are shown together, in one
  list and one rotation, each marked with its site (in the list, and "From
  your chess.com game ..." on the puzzle).
- **Which games.** The player's rated rapid games (standard chess, not
  against the computer). A game counts when the player's rating in it was at
  least 80% of their current rapid rating on that site.
- **Update puzzles** asks the bridge to bring each account up to date
  (`bridge/puzzles.go`, with the fetching in `bridge/games.go`): it checks
  the rapid rating, fetches the games played since the last update (the
  first time the newest ones, about 100), analyses the games that count,
  each account's newest first and the accounts taking turns, and fetches
  older games whenever it runs out, about 100 at a time, until every game
  that counts has been analysed, or a batch of older games brings none that
  count (the player's rating was lower then). It does all of this by itself:
  the site's tab can be closed. When the rating has changed, the games
  already fetched are only checked against the new limit (their rating is
  stored): puzzles from games that no longer count are set aside, and games
  that now count are analysed. **Stop** ends the update; the next one
  carries on.
- **Collecting.** What the bridge finds waits in `puzzles.json` next to its
  settings, with the games still waiting and how far fetching got, until the
  page collects it: the page follows the bridge while it is open (progress,
  and each game's puzzles as they come) and, opened again later, collects
  what was found meanwhile. A bridge that is closed in the middle carries on
  when it is started again, and the page finds it again by itself (it looks
  every 15 seconds after losing it). **Delete these accounts' data** also
  makes the bridge forget them.
- chess.com lists the odd month it then cannot find; such a month is passed
  over and asked for again at the next update.
- **Game analysis**, as Lichess's computer analysis does it: every position
  searched to 1,000,000 nodes (`Origin.manualRequest` in lila's fishnet
  module), and Lichess's judgement of each of the player's moves (inaccuracy,
  mistake, blunder, lila `Advice.scala`). A Lichess game that Lichess has
  analysed already comes with Lichess's own evaluations, which are used.
- **Puzzles** (`bridge/puzzlegen.go`, where the rules are written out in
  full, with the chess rules it needs in `bridge/chess.go`, a port of
  `web/chesslib.js` checked against the same perft counts).
  Only where the player's move was not the best one found and Lichess marks
  it:
  - *Lichess puzzles*: the rules of Lichess's own puzzle generator
    ([lichess-puzzler](https://github.com/ornicar/lichess-puzzler), version 50):
    the opponent's move has just given the player a winning chance (a jump of
    more than 0.6 in winning chances to +2.00 or more) or a mate, and every
    move of the player's in the solution is the only good one (0.7 winning
    chances better than the second-best; two lines searched to depth 50,
    25 million nodes or 30 seconds). One-move puzzles are kept, and every
    puzzle of a game.
  - *Only moves*: Lichess makes puzzles only where the opponent has just
    blundered, which leaves out most of what a player misses (it found none
    in 30 rapid games of a 1365-rated player). So where the player's move was
    a mistake or a blunder and there is no Lichess puzzle, the position is a
    puzzle when every other move loses at least 0.3 winning chances against
    the best one (what Lichess calls a blunder), and the line goes on while
    the player's next moves are again such only moves. In those 30 games this
    gave 10 puzzles.
  - Either way it is kept only if the player's move in the game was not the
    solution's first move (nor another checkmate), and a position already in
    the pool from another game is not added twice.
- **Engine effort** (*Settings and data*): "As Lichess" uses the numbers
  above; "Quicker" analyses each position to 300,000 nodes (Lichess's
  background analysis) and searches puzzles to 5 million nodes or 10 seconds.
  With Stockfish 19 on 8 threads, a rapid game took about 36 seconds as
  Lichess (20 to 90) and about 10 seconds quicker, and there was a puzzle in
  every three to five games either way. Puzzles show up as they are found.
- **The bridge's engine for puzzles** (`bridge/search.go`): one Stockfish
  process, apart from the analysis queue and live analysis, runs one limited
  search at a time (several lines; a node, depth or time limit; the game's
  moves before the position, so that Stockfish sees repetitions). It gets a
  share of the processor like one more analysis (and counts as one for
  analyses and live analysis started meanwhile), a hash table of at most
  1 GB, and ends after a minute without searches. The view says when the
  bridge is missing or too old, with a button to the setup (or update)
  instructions.
- **Puzzles come first**: their engine always searches with all the threads
  the bridge may use (all cores but one), also while analyses of positions
  run; an analysis started meanwhile counts it as one more analysis when it
  takes its share, so the puzzles keep the larger part of the processor.
  **Stop** with no other update left closes the engine.
- The bridge's API for it: `POST /api/puzzles/update` (`{profile, site,
  username, effort}`), `GET /api/puzzles?profile=` (the rating, how many
  games are fetched, count and are analysed, what it is doing, and what it
  found), `POST /api/puzzles/collected` (`{profile, games}`), `POST
  /api/puzzles/stop` and `POST /api/puzzles/forget` (`{profile}`);
  `/api/status` has `"puzzles": true`. The bridge asks chess.com and Lichess
  as `mychessdb-bridge/<version>` (chess.com turns away requests without a
  name).
- **Solving**: the opponent's last move is played, then it is the player's
  turn; ◀ (or the mouse wheel, or the arrow keys) shows the position
  before it, ▶ comes back. A move must be the solution's, but any checkmate
  is accepted, as on Lichess; the opponent's replies are played
  automatically. A wrong move is shown and taken back, and the puzzle counts
  as missed; **Show solution** plays the rest. The board is the best-move
  board's: the same marks for where a piece can go, dragging, right-click
  arrows and circles (red with Ctrl), and each side's captured pieces with
  who is ahead in material. Afterwards the arrows go
  through all the moves, and the panel shows the solution, the move played
  in the game with Lichess's judgement, and a link to the game.
- **Analyse in Best moves** (once a puzzle is done) opens the game up to the
  puzzle and the solution on the best-move board, at the position shown, with
  its history and opening name, where live analysis takes over.
- **When puzzles come back** (`web/puzzlestore.js`): solved at the first try,
  after 1, then 3, then 7 days; solved at the first try a fourth time in a
  row, it leaves the list ("mastered"; **Show** *the mastered puzzles* lists
  them with **Bring back**). A miss sets it back to the start: it is due at once
  and comes back after three other puzzles, again and again until it is
  solved. Missed puzzles come first, but never two in a row while other
  puzzles are due; then new ones, newest game first. Solving a puzzle before
  it is due (**Practice anyway**, or from the list) does not move it on, but
  a miss counts.
- **On the server, with a key.** Logged in with the admin token or a
  contributor key (on the best moves, or before opening the puzzles), the
  accounts are also kept in the database (`puzzle_store`,
  `migrations/0005_puzzles.sql`), for that key alone: the admin's lists and
  each contributor key's are apart. Every browser logged in with the key has
  the same ones: a phone logged in with it opens the accounts by itself, and
  the puzzles a computer's bridge finds reach it at its next sync. The page
  syncs when the puzzles are opened or shown again, a moment after each
  change (a puzzle found, a try, a delete), and every minute while they are
  on screen: it sends what changed in the browser and gets back what changed
  on the server since its last sync (each account counts its writes, `rev`).
  Of two changes to one puzzle the later one wins (`changedAt`, when it was
  made; a clock more than a minute ahead counts as now). Only the games that
  have puzzles are sent, not the ones without. **Delete these accounts'
  data** deletes them from the server first, and the other browsers logged in
  with the key delete their copy at their next sync (the account's row stays
  as a mark). The first sync with a key sends everything the browser has,
  also what was there before logging in; logged out, the browser keeps its
  copy and works on its own. A revoked key reaches its lists no longer; they
  stay in the database. The admin's backup does not include them.
- The server's API for it (key only): `GET /api/puzzles/profiles` (the key's
  accounts), `POST /api/puzzles/sync` (`{profile, since, items}`, at most 200
  items in, 500 out; `{gone}` for an account deleted elsewhere, `{missing}`
  for one to send again) and `POST /api/puzzles/forget` (`{profile}`);
  `/api/session` tells whose lists the key reaches (`owner`).
- **Delete this puzzle**, offered once the puzzle on the board is solved or
  its solution shown, takes it out of the list and shows the next one. It
  stays in the browser, marked deleted (with how it was solved), so the
  bridge's results never add it again, nor the same position from another
  game; **Undo** right after it, or **Bring back** in *the deleted puzzles*
  of the list, returns it to the list as it was. Importing keeps whichever
  was decided last (deleted, or brought back).

### The Lichess evaluation database

Lichess publishes every evaluation it has stored
(<https://database.lichess.org/#evals>, about 416 million positions in one
file). `scripts/lichess_db.mjs` takes the deep ones out of it and turns them
into SQL for the `lichess_db` table. A position's Lichess entry is then the
deeper of what was saved from the site and what is in that table; on the page
such an entry is marked "Lichess database". These rows are reference data:
they have no history, are not in the backup, and the admin's **Remove** does
not touch them.

This has to be run on your own PC (the file is large and its address is not
reachable from where the site was developed), with Node.js 22.15 or newer:

```powershell
# 1. Download lichess_db_eval.jsonl.zst from database.lichess.org, then:
node scripts/lichess_db.mjs extract lichess_db_eval.jsonl.zst
# 2. Turn what was kept (lichess_db.jsonl) into SQL files:
node scripts/lichess_db.mjs sql
# 3. Optional: try it locally with `npm run dev` first
node scripts/lichess_db.mjs load-dev
# 4. Run each file on the real database:
npx wrangler d1 execute mychessdb --remote --file=lichess_db_sql/lichess_db_0001.sql
```

Step 1 reads the whole file once (22 GB packed; expect about an hour) and
changes nothing anywhere. It writes what it keeps to `lichess_db.jsonl` and
prints how many positions reach depth 46, divided by depth, by number of
pieces on the board and into forced mates and the rest, and roughly how much
room they take. `--limit 4000000` reads only the first four million positions,
to see it work in under a minute. `--min-depth` and `--pv-plies` (moves kept
per line, 16 by default) change what is kept.

Expect a very large number. In the first 1.4% of the October 2026 file, 15%
of the positions reached depth 46, which would be around 43 million in all,
some 5 GB. Most of them are positions where depth costs nothing: 71% were
forced mates and 57% had seven pieces or fewer. Only about 5% had 30 or more
pieces on the board. (The file is not in random order, so the whole of it may
divide differently.)

So decide what to load once you have the real numbers. The free plan allows
500 MB per database (roughly 4 million of these rows) and 100,000 row writes
a day; the paid plan 10 GB and 50 million writes a month. Step 2 can take a
part of what was extracted without reading the dump again:

```powershell
node scripts/lichess_db.mjs count --min-pieces 28          # how many, and what each --max-moves N would keep of them
node scripts/lichess_db.mjs count --max-moves 10           # how many, and what each --min-pieces P would keep of them
node scripts/lichess_db.mjs sql --max-moves 10             # positions from the first 10 moves
node scripts/lichess_db.mjs sql --min-pieces 30            # nearly everything still on the board
node scripts/lichess_db.mjs sql --no-mates --min-pieces 16 # no forced mates, no bare endings
```

`count` takes the same options as `sql` and writes nothing: its first line is
the number of rows `sql` would write with them.

`--max-moves N` keeps the positions that can be from the first N moves of a
game. The Lichess file does not say at which move a position was reached, so
this is worked out from the position: the fewest moves each side must have
made to get its pawns and pieces where they stand, counting one more for
every piece the other side has lost. Every position that really is from the
first N moves is kept. Others are kept too, because that least number can be
far below what a real game took: above all positions with many pieces gone,
which need only one move for each piece taken. Use `--min-pieces` with it (in
the first ten moves of a real game there are seldom fewer than 28 pieces).

Each SQL file holds 50,000 rows, can be run in any order and more than once,
and a row only replaces a stored one that is less deep, so the import can be
spread over days and repeated when Lichess publishes a newer file.

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

When a later version adds a file to `migrations/` (as the per-engine storage
did with `0002_engines.sql`, and the puzzles kept for keys with
`0005_puzzles.sql`), download a backup from the admin tools first, then run
the first two of these commands again, one right after the other: between
them the old site code meets the new tables and saving fails.
(`0005_puzzles.sql` only adds a table, so there the old code goes on working.)

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

Phones and tablets cannot run the bridge, so there the page neither offers
nor looks for it (no local network prompt). They see saved moves, fetch
Lichess's evaluation (in Combined the button does only that), and run live
analysis with the browser engine; the Stockfish 19 view's button, which
analyses to a chosen depth, is disabled. The layout follows the screen: held
upright, the board is as wide as the screen and the panel is below it; held
sideways (and on computers), the board fits the height and the panel is
beside it.

On the board a piece is moved by clicking it and then where it goes, or by
dragging it; a pawn that reaches the last rank asks which piece it becomes
(on the puzzle board too), and × or a click beside the choice cancels. The
material count beside the board always comes from the pieces on it, so a
promotion counts. A best move that promotes shows the piece it becomes in the
corner of its square (and as "=Q" and so on in the line below). With a
finger a piece is dragged only once it moves more than 12 pixels (6 with a
mouse), a piece dragged back to its square stays selected, and a long press
keeps it selected. The squares also work from the keyboard (Tab, then Enter
or Space).

The installer adds a "My Chess DB Bridge" launcher (Start menu shortcut on
Windows, Applications entry on macOS and Linux) for next time; the site also
shows a short start command. The bridge's window has to stay open while
analysing.

Up to four analyses run at the same time (`-max-jobs` changes that). Further
ones wait in a queue, up to 100, and start by themselves, oldest first, as
soon as one of the four ends; a paused analysis keeps its slot. Pausing an
analysis that is still waiting holds it: it keeps its place in the list, the
ones behind it start first, and **Resume** puts it back in line where it was
(it starts at once if a slot is free). Stockfish
runs below normal priority. It may use all processor cores but one and a
quarter of the memory (at most 8 GB) for its hash table, shared between the
analyses running at that moment, and a new analysis never takes more than half
of the memory that is free when it starts. The bridge window logs the threads
and hash size each analysis started with.

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

- **Remove saved move**: removes the entry that is on screen for the position
  on the board (one engine's; the other engine's stays). It stays in the
  history.
- **Remove all from this visitor**: when the entry on screen is unverified
  (saved without a key), removes every unverified entry the same visitor
  saved, for when someone fills the database with bad moves. Entries saved
  without a key carry a salted hash of the visitor's network (an IPv6 /64
  counts as one network), never the address itself. Where that visitor had
  replaced someone else's entry, that entry is put back (the newest one from
  someone else in the history, unless the admin had removed it or restored
  another over it). What is removed stays in the history.
- **History of this position**: every replaced or removed entry, each with a
  **Restore** button.
- **Contributor keys**: create a key for someone you trust; it is shown once.
  Their Stockfish results are then saved as verified. **Revoke** stops the
  key; **Revoke + unverify entries** also marks everything saved with it as
  unverified, so it can be replaced.
- **Download backup**: everything saved from the site, including history, as
  one JSON file (not the rows imported from the Lichess evaluation database). The same file can be imported again; entries that were unverified
  stay unverified. Import only fills gaps: it never replaces an entry of equal
  or greater depth, and it does not restore history or contributor keys.

Settings you can change in `wrangler.jsonc` under `vars`: `MIN_DEPTH`
(default 21: nothing shallower is saved or can be chosen), `FULL_DEPTH`
(default 46: the depth shown in full colour, and where the depth field
starts), `ANON_WRITES_PER_HOUR` (default 600 save attempts per hour for a
visitor without a key) and `ANON_LIVE_WRITES_PER_HOUR` (default 500: how many
of those may come from live analysis, which saves by itself; the rest stay
for analyses run with the button). At about three rows written per save,
600 an hour lets one visitor without a key use some 15% of the free plan's
daily row writes in eight busy hours; lower it if many such visitors come.
IPv6 visitors are counted per /64, the block one connection normally has.

Twenty wrong keys in an hour from one network stop keys from being checked
for that network until the hour is over (the right one included), so the
admin token cannot be guessed at speed. Use a long random admin token all the
same.

## Free plan limits to know about

- 100,000 API requests per day; static files do not count.
- D1: 5 million rows read and 100,000 rows written per day, 500 MB per
  database. Showing a position reads its own rows only (three at most).
  Looking up the positions one move away, or the moves before a loaded
  position, reads up to three rows for each of them. Such lookups are counted
  per visitor's network by the rate limiting binding `HEAVY_READS` in
  `wrangler.jsonc` (one unit per 40 positions, 120 units a minute); past it,
  only the position itself is answered for a while, and the page carries on
  with one position per request. The count is kept per Cloudflare location
  and is approximate. Remove the `ratelimits` block to turn it off.
- The page only fetches a position where the board stops: scrolling quickly
  through a game sends a request for the first and last position, not for
  each one on the way.
- When a daily limit is hit, the API returns errors until 00:00 UTC.

## Development

```powershell
npm run dev          # http://localhost:8787, local SQLite file, no Cloudflare needed
npm test             # chess rules, API rules, Lichess database import, puzzles
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
files. The current ones (1.0.8) were built with Go 1.24.7.

The site names the bridge version it expects (`BRIDGE_MIN_VERSION` in
`web/app.js`). An older bridge keeps working, and the site shows an **Update**
button with the install command. Bridges before 1.0.4 do not report the search
as it goes, so with them the page is not updated during an analysis and Stop
saves nothing. Bridges before 1.0.5 cannot hold an analysis that is waiting in
the queue; with them its Pause button stays disabled. Bridges before 1.0.6 have
no live analysis, and bridges before 1.0.8 cannot find puzzles (1.0.7, the
first with puzzles, gave them only a share of the processor).

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

Automated tests (Linux, real browser):

- chess rules against published perft counts and 28,694 positions from
  python-chess; opening table identical to the old `app.py` logic
- every API rule against SQLite (the engine behind D1)
- the per-engine views in the browser (combined, Stockfish 19, Lichess), and
  `migrations/0002_engines.sql` on a copy of the development database (501
  entries, all carried over unchanged)
- `scripts/lichess_db.mjs` against a small stand-in for the Lichess file, in
  the same format and packed the same way
- the released Linux bridge downloading the official Stockfish 19 from GitHub,
  analysing, pausing, resuming, stopping, and cleaning up
- with that real Stockfish 19 and with a stand-in engine: the page following
  a running analysis (best move, evaluation, line, evaluation bar), Stop
  saving the depth finished last, a deeper saved analysis staying on screen,
  and the paler green below depth 46
- the analysis queue (waiting, order, dropping or holding a waiting job,
  starting by itself, shutdown) and the free-memory limit on the hash size
- the positions one move away arriving with a position (a move shows its
  saved result while the request for it is still held back), and the captured
  pieces above and below the board following Flip board
- the macOS/Linux install script (on Linux)
- importing the real `saved_positions.json` (492 entries, none skipped)
- puzzles in the page (`tests/puzzles.test.mjs`): when puzzles come back;
  deleted puzzles (never due, and merging an import's copy); when each one
  last changed
- puzzles kept for keys (`tests/worker.test.mjs`, Windows 11): no key or a
  wrong or revoked one, bad requests, the first sync, another browser getting
  everything and then only what changed, an older change losing (and the
  newer one sent back), a clock far ahead, pages of 500, each key's lists
  apart, an account deleted (other browsers told, revs going on when it is
  sent again), an account the server does not know
- puzzles in the engine bridge (`npm run test:bridge`, Windows 11): the chess
  rules against the same perft counts as chesslib.js; Lichess's judgements and
  both kinds of puzzle with a scripted engine; the searches with a stand-in
  engine (several lines, the limits passed on, bad input refused,
  cancelling, one engine for one search after another, closing it when
  idle); reading chess.com and Lichess games (PGN, SAN, which games count)
  and fetching them in batches, against a stand-in for both sites, also a
  month chess.com cannot find; an update to the end (rating, games, newest
  first, collecting, a second update analysing nothing twice, a player who
  is not there, forgetting), two accounts taking turns, Stop, and carrying on
  after the bridge was closed

Checked by hand on the live site, Windows 11 with Firefox:

- deploy with wrangler and the real D1 database
- `install.ps1`, the Start menu shortcut, and the browser's one-time
  permission prompt
- the Windows bridge: Stockfish download, analysis, pause, resume, stop,
  closing the bridge window, reload during an analysis
- an analysis saved from the PC and visible to a visitor who is not logged in
- `migrations/0002_engines.sql` on the real D1 database, and the first file of
  `scripts/lichess_db.mjs` output (`--max-moves 10 --min-pieces 28`, run on
  the whole Lichess file) loaded with wrangler

Puzzles, checked by hand on Windows 11:

- the puzzle finder with the real Stockfish 19 on 30 real Lichess rapid
  games of a 1365-rated player: 10 puzzles from the first version (in the
  page), 8 from the bridge's (mostly the same positions; Stockfish on
  several threads does not find exactly the same lines twice), checked by eye
- bridge 1.0.7 and 1.0.8 with the real Stockfish 19, chess.com and Lichess, and the
  page in the browser built into the Claude desktop app (Chromium): a
  chess.com and a Lichess account updated together (232 chess.com months
  fetched by the bridge, the accounts taking turns, their puzzles in one
  list), the bridge closed and started again in the middle (it carried on,
  and the page found it again), the tab closed while the bridge went on and
  the puzzles collected when it was opened again, Stop, deleting the
  accounts, switching to the best moves and back, solving (click and
  drag, a wrong move, a three-move line with the reply played by itself, ◀
  to the position before the opponent's move, the solution, the promotion
  choice, arrows and circles, captured pieces), the order puzzles come back
  in, **Analyse in Best moves** with live analysis on the bridge, and the
  phone layout
- fetching a chess.com player's games in that browser (232 months, 36 rated
  rapid games read)
- in that browser: promotion on the best-move board (to a knight for White,
  dragged to a rook for Black on the flipped board, the history back and
  forth, the material count) and on the puzzle board (a puzzle solved with
  a8=Q); a phone's tap simulated with touch pointer events and a click 40 ms
  later (the piece stays selected; the same late click on the promotion
  choice picks nothing), a long press, a tap that moves 9 pixels, a piece
  dragged back to its square, the keyboard; the key note on a phone's width;
  a saved best move that promotes (a stand-in answer from the page's fetch:
  a white knight badge on b8, a black rook badge on g1 of the flipped
  board), and +9 for Black after g1=Q; a puzzle without its game's moves
  whose position has a promoted queen (the missing pawn not counted as
  taken). On a real phone this has not been tried.
- puzzles kept for keys, in that browser against the development server
  (`scripts/dev_server.mjs`, which applies `0005_puzzles.sql` to its
  database), with stand-in puzzles: one tab on `localhost` and one on
  `127.0.0.1` (two origins, so two separate browser stores, as two devices):
  the first sync of a contributor key (the account, the three games with
  puzzles and not the one without, the three puzzles), switching that tab to
  the admin token (everything sent again for the admin), the other tab
  logged in with no accounts opening the admin's account from the server
  (rating, counts, puzzles; no update started), a solution shown, a delete
  and a first-try solve there reaching the first tab, and **Delete these
  accounts' data** in the first tab removing the account from the second at
  its next sync. Not yet against the real D1.
- **Delete this puzzle** in that browser, with stand-in puzzles: not offered
  before the puzzle is done nor after a wrong move, offered once the
  solution was shown; the next puzzle shown, Undo, two deleted and listed,
  one opened from the list (no delete button) and brought back while on the
  board (a miss then recorded with it kept in the list), all of it still
  there after a reload

Not yet run anywhere:

- bridge 1.0.8 on macOS and Linux, and its install over 1.0.6 with the
  install command (on Windows it was run from a build, not installed)
- the puzzle animations seen on screen (the desktop app's browser was hidden
  while it was tested, so the animations were checked to start, not watched)

- the browser engine with several threads: the browser built into the
  Claude desktop app, where it was tested (download, check, live analysis,
  saving, handing over to the bridge and back), cannot start a worker from a
  worker, so there it ran with one thread. Several threads need a check in
  Chrome, Edge or Firefox.
- the Windows-only parts of the bridge added in 1.0.3: reading free memory,
  and marking Stockfish's memory as the first to give up when memory runs
  short
- bridges 1.0.4 and 1.0.5 on Windows and macOS (their tests ran on Linux)
- bridge 1.0.6 (live analysis) on Linux and macOS, and the live-analysis
  step of `tests/e2e.mjs`. The bridge tests (`npm run test:bridge`) passed on
  Windows 11 with Go 1.24.7; the page side was checked in Chromium against a
  stand-in for the bridge's live-analysis API.
- the depth field's reset, the evaluation bar and the paler greens in Firefox
  (tested in Chromium)
- anything on macOS (bridge, installer, launcher)
- the Linux launcher on a real desktop
- the permission prompt in Chrome and Edge
- whether Lichess answers the server-side check from Cloudflare's network
  reliably (it was tested against a stand-in)

## Credits

Opening names: [lichess-org/chess-openings](https://github.com/lichess-org/chess-openings), CC0.
Engine: [Stockfish](https://stockfishchess.org), GPLv3. The engine bridge
downloads the official release on each user's computer. The browser engine is
[stockfish.js](https://github.com/nmrugg/stockfish.js) 19.0.0 (GPLv3): its
loaders are served by this site and its WebAssembly files from the npm package
on unpkg; its license is in `web/engine/Copying.txt` (linked from the page)
and its source at the links above.
