# My Chess DB

A focused local chess position tool:

- interactive chess board and notation
- pieces can be moved by clicking squares or dragging
- pointer dragging can be canceled with the right mouse button before release
- Stockfish verification checks the binary's SHA-256 against the trusted
  official Stockfish 19 Windows x86-64 universal build, then checks its UCI identity
- opposite annotations on the same squares are drawn as separated curved arrows
- selecting a piece shows legal empty destinations and capturable pieces
- only pieces belonging to the side to move can be selected or moved
- clicking a highlighted destination moves the piece without dragging
- castling is supported when the FEN castling rights and path allow it
- saved best moves are highlighted automatically when the matching position opens;
  saved castling highlights both the king's and rook's source and destination
  squares and stays visible while the king is selected or dragged
- one button checks Lichess Cloud Evaluation first, then falls back to Stockfish 19
- multiple positions can be analyzed with Stockfish at the same time; each
  running analysis gets its own share of CPU threads and hash memory,
  calculated dynamically from the number of jobs running at once and the
  machine's core count and RAM; any running analysis can be **paused** to
  free up the CPU for other work and **resumed** later without losing progress
- the returned best move is saved automatically when the configured depth is met
- Stockfish evaluations are shown in pawns from White's perspective (for example,
  `+0.32`); forced mates are shown as `#3` or `#-3`
- saved best moves can be removed
- move, capture, castling, check, and checkmate sounds are generated locally in
  the browser without external audio files

## Run on Windows

1. Install Python 3.11 or newer.
2. Create the project virtual environment:

   ```powershell
   py -m venv .venv
   ```

3. Install dependencies inside the virtual environment:

   ```powershell
   .\.venv\Scripts\python.exe -m pip install -r requirements.txt
   ```

4. Start the local application with the virtual environment:

   ```powershell
   .\.venv\Scripts\python.exe app.py
   ```

5. Open `http://127.0.0.1:8765` in your browser.

6. On first use, enter the path to your local Stockfish 19 executable in the
   **Stockfish 19 executable** field. Select the actual Windows `.exe` file,
   for example `stockfish-windows-x86-64-avx2.exe`, not the downloaded ZIP,
   extracted folder, or a quoted path.
   The executable path is saved per anonymous browser ID; the server returns
   each browser's own settings, not another user's local path.

## Launch without opening VS Code or typing commands

Two double-clickable launchers are included so you don't need a terminal or
editor open every time:

- **`start.bat`** — starts the server with a visible console window (useful
  if you want to see logs or Stockfish errors), then opens the app in your
  default browser after a couple of seconds.
- **`start.vbs`** — starts the server completely silently (no console window
  at all, using `pythonw.exe`) and opens the app in your browser. This is the
  most convenient option for everyday use.

Double-click either file directly in File Explorer. You can also pin one to
your Start Menu or Taskbar, or create a Desktop shortcut to it, so opening
the chess database becomes a single click.

To stop the server started by `start.vbs` (since it has no visible window),
end the `pythonw.exe` process from Task Manager. `start.bat`'s server can be
stopped by closing its console window or pressing `Ctrl+C` in it.

You can also activate the environment for the current PowerShell session:

```powershell
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python app.py
```

All application dependencies are installed under `.venv`; they are not
required globally.

Saved positions are stored in `saved_positions.json` next to the application.
Click **Find and save best move** to query Lichess Cloud Evaluation first. If
its cached depth is at least the configured **Analysis depth**, the first
cloud principal variation is saved automatically. If the cached depth is
lower, or Lichess has no cached evaluation, the application runs Stockfish 19
at the configured depth and saves its best move automatically. The button
shows the Stockfish progress when local analysis is needed.
If Lichess Cloud returns a rate-limit response, the job displays **Use Stockfish**
and **Dismiss** buttons inline under Running analyses; no browser alert or popup
is shown. Choosing Stockfish starts local analysis, while Dismiss keeps the
rate-limit message without starting an engine.
Non-admin users always use depth 46; only an authenticated admin can change
the analysis-depth setting. The server enforces this even if a request supplies
a different depth directly.
The current verifier accepts only the trusted Stockfish 19 Windows x86-64
universal executable included in this project; renamed or modified executables
are rejected even if they claim to identify themselves as Stockfish.
Local Stockfish analysis can run for up to 12 hours before the application
reports a timeout.

While Stockfish is analyzing, the button label changes to **Stop analysis**
whenever the currently loaded position has a running job. Clicking it cancels
only that run immediately (the Stockfish process for that job is stopped on
the backend too, so it stops using CPU) and nothing is saved for that run.
Navigating to a different position, loading another FEN, or moving pieces
while an analysis is running does **not** interrupt it — the analysis keeps
running in the background and, once finished, automatically saves the best
move to the position that was actually being analyzed (not whatever position
happens to be on screen at that moment).

### Analyzing multiple positions at once

Clicking **Find and save best move** on a position that is not already being
analyzed starts a new job without touching any other analysis already in
progress, so several different positions can run through Stockfish at the
same time. A **Running analyses** list appears under the analyze button
showing every active job (its opening name when known, current status/depth,
and its own **Pause**/**Resume** and **Stop** buttons), so any of them can be
paused or cancelled individually. Click an opening name to load that job's
position onto the board. Opening names come from the bundled Lichess
`chess-openings` catalog. Without tracked move history, a position that does
not match the catalog appears as **Unclassified position**. Since FEN stores a
position but not the moves used to reach it, a transposed position cannot
always be assigned the same unique opening name as a full game record. The
catalog is CC0 and its license is included in [openings/COPYING.txt](./openings/COPYING.txt).

When moves are played from the starting position, the panel below the board
tracks the move sequence and shows the latest matching opening name. If the
current position is beyond the catalog, the most recently recognized opening
name stays visible with the played continuation appended, so analysis jobs
still carry that opening context. Loading an arbitrary FEN starts a separate
move history and hides the opening panel because FEN does not record how the
position was reached.

The first/back/forward/latest arrow buttons below the board navigate the
current move history; scrolling down/up over the board also moves forward/back.
Navigation plays the same move, capture, castle, check, or mate sound as the
corresponding move. File/rank coordinates are shown on the board. Captured
pieces are shown below it grouped by piece type, with icons slightly overlapped.
Only the side with a material advantage gets a `+N` beside its captured pieces;
equal material has no summary text. Right-click annotations use green arrows/circles;
hold Ctrl while adding one for red. Selecting or dragging a saved best-move
piece keeps the selection highlight yellow.

Completed analyses stay in **Running analyses and results** until dismissed.
If a completed position is not currently open, the app asks whether to open it;
the opening name remains clickable to revisit it later. The **Dismiss** button
removes a finished result. Analysis jobs preserve the board orientation used
when they started, and each browser stores its own orientation preference per
position. Loading a position from the running-analyses list restores that
job's tracked history and orientation, so the navigation buttons remain usable.
Less-frequently-used FEN, engine, analysis-depth, and saved-move removal
controls are grouped under **Position and engine settings**.

Because Stockfish is given the whole machine's resources when it runs alone,
each additional concurrent job automatically gets a smaller share: at the
moment a job starts, the app divides the total thread budget (CPU core count
minus one, reserved for the OS/UI) and hash budget (about a quarter of system
RAM, capped at 8 GB) across however many analyses are running at that instant.
This means running many positions at once is slower per position — by design,
since the goal is higher overall throughput rather than the fastest single
analysis. Jobs that are already running keep the allocation they started
with; only new jobs re-measure the current load.

If running several analyses at once causes noticeable lag in other work,
click **Pause** on the jobs you care about least. This freezes the Stockfish
process at the OS level (`SIGSTOP` on Linux/macOS, an internal suspend API on
Windows) so it stops using CPU entirely, while keeping its search progress —
including the hash table — held in memory. Clicking **Resume** unfreezes the
process and analysis continues exactly where it left off, with no restart and
no lost depth. Pausing does **not** free the RAM the job's hash table is
using; only CPU usage is affected. A paused job can still be stopped normally
via its **Stop** button. Pausing only works while the app's backend process
stays running — closing `app.py` or restarting the computer still loses any
in-progress (including paused) analysis, since Stockfish's internal search
state only exists in that process's memory and cannot be saved to disk.
