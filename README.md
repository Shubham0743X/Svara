# Svara

A YouTube-Music-style desktop player for Windows — **no account, no login**. Search, play, queue, and
keep a library that lives entirely on your machine (favourites, playlists, history and settings are
all local `localStorage`, so nothing is sent anywhere except the API calls that fetch music).

Built as a personal project: an Express backend that talks to YouTube Music through
[`youtubei.js`](https://github.com/LuanRT/YouTube.js), and a single-file front end shown in Electron.

## Features

- **Search** songs, albums and artists with live suggestions, result filters (All / Songs / Albums /
  Artists), paging, and a top-result artist card with Shuffle / Mix.
- **Home** with mood pills (Relax, Romance, Feel Good, Party, Energize, Focus, Sad, Workout),
  *Listen again*, *Quick picks*, *Albums for you*, and *Play a radio from your taste* — the radio is
  seeded from what you actually listen to.
- **Player** page: crossfade and stream prefetch so a track starts instantly, an Up-next queue,
  shuffle / repeat, and karaoke-style synced lyrics (LRClib, with YouTube Music as the untimed
  fallback) including a fullscreen lyrics view.
- **Library** page with Playlists / Songs / Albums / Artists tabs and Recently played / A–Z sorting.
- **Liked music**, **liked albums**, playlists you can create, rename, pin and delete, and a
  listening history.
- **Downloads** — save a track as audio via `yt-dlp`, with Windows-safe file names.
- **Appearance** — Low / Medium / High graphics level, Text size (100–115%), album-colour ambient
  wash, and glass pill buttons throughout.
- A **mini player** that only appears once something is actually playing.

## Requirements

- **Windows 10/11** (the packaged build is a Windows portable exe).
- **Node.js 18+**.
- **`yt-dlp.exe`** — *not* included in this repository. Download it from the
  [yt-dlp releases page](https://github.com/yt-dlp/yt-dlp/releases) and put it next to `server.js`
  (or set the `YTDLP` environment variable to its full path). The Electron app also looks for a copy
  in its user-data folder, so `yt-dlp -U` can update itself there.

## Run it

```bash
npm install
npm start          # Express API + UI on http://localhost:3000  (works in a normal browser)
```

For the desktop window, leave the server running and start Electron in a second terminal:

```bash
npm run dev        # Electron shell — it waits for the server on :3000 and retries
```

Build the Windows portable app (outputs to `dist/`, which is git-ignored):

```bash
npm run build
```

The port is deliberately fixed at **3000**: your library is tied to that origin in `localStorage`,
so changing it would look like a fresh install.

## How it works

| Piece | What it does |
| --- | --- |
| `server.js` | Express API. Search (`/api/search`, `/api/search/next`, `/api/suggest`), `/api/radio`, `/api/artist`, `/api/artist/songs`, `/api/album`, `/api/lyrics`, `/api/stream`, `/api/prefetch`, `/api/download`, `/api/thumb`, `/api/system`, and `/fonts/:file`. Audio is resolved and streamed through `yt-dlp`. |
| `index.html` | The whole UI: markup, styles and scripts in one file, grown in numbered "waves" — each feature is an appended `<style>`/`<script>` block that documents its own reasoning in place. |
| `electron/main.js` | The window: single-instance lock, hardened session (permissions allowlist, external links opened in the real browser), cache cleared only after an update, and a wait-for-server loop. |
| `PLAN.md`, `WAVE0-NOTES.md` | The build log: what each wave changed, what was verified, and the layer map of the single-file UI. |
| `fonts/` | Bundled UI and title fonts, served from `/fonts` (see `fonts/COPYRIGHT.txt`). |

## Notes and limits

- Windows-first: the Electron build, the `yt-dlp.exe` lookup and the download file names all assume
  Windows.
- Audio and artwork come from YouTube via `yt-dlp`. This is a personal-use project, **not affiliated
  with, endorsed by or sponsored by YouTube or Google**; anything you download is your own
  responsibility under YouTube's Terms of Service.
- Streaming and downloads need `yt-dlp.exe` in place; without it the UI still runs, but playback and
  downloads fail with a specific error message.

## License

The **code** is [MIT](LICENSE).

The **bundled fonts are third-party and are not covered by the MIT licence** — see
[`fonts/COPYRIGHT.txt`](fonts/COPYRIGHT.txt) for their copyright notice.

## Author

Shubham Nag — [GitHub](https://github.com/Shubham0743X) · [Instagram](https://instagram.com/notso_shubhamm)
