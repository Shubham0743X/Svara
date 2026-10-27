# Svara

**A YouTube-Music-style desktop player for Windows — no account, no login.**

Search, play and queue music, keep a library of liked songs, albums and playlists, follow
karaoke-style synced lyrics, and save tracks for offline listening — all from one app that keeps
your library on your own PC.

## Download

Svara ships two ways. Same app, same music — pick whichever suits you.

### ▶ [Download the Svara installer](https://github.com/Shubham0743X/Svara/releases/latest/download/Svara-Setup-1.3.0.exe)

A normal Windows install: a Start Menu entry, a desktop shortcut, and an uninstaller, so Svara
updates and leaves like anything else on your PC. **This is the one to pick** unless you want a
file you can carry around.

1. Click the link above — you get `Svara-Setup-1.3.0.exe` (about 128 MB).
2. Run it. It asks where to put Svara, installs in a few seconds, and can open the app for you when
   it finishes.
3. Start playing.

To remove it later: **Settings → Apps → Installed apps → Svara → Uninstall**.

### ▶ [Download Svara portable](https://github.com/Shubham0743X/Svara/releases/latest/download/Svara.1.3.0.exe)

One file, no installer, no admin prompt — handy for a USB stick or a PC you don't want to change.

1. Click the link above — you get `Svara.1.3.0.exe` (about 114 MB).
2. Put it wherever you like (Desktop, a folder, a USB stick) and double-click it.
3. Start playing.

Every version, with its notes, lives under [**Releases**](https://github.com/Shubham0743X/Svara/releases).

**The first time you open it**, Windows may show a blue *"Windows protected your PC"* box. That is
SmartScreen flagging an app that isn't code-signed (a yearly certificate the project doesn't buy),
not a warning about anything Svara does — click **More info → Run anyway**. It applies to both
downloads, and only to the first launch.

**Where your library lives.** Liked songs, liked albums, playlists, your listening history, the
theme, the graphics level and the text size are kept in `%APPDATA%\Svara`, never inside the app
itself. Installing, updating, reinstalling or uninstalling Svara never touches them — and the
portable copy reads the same folder, so the two are interchangeable.

**Run one copy at a time.** The installed and portable versions both serve the app on port 3000, so
close one before opening the other.

**Needs:** Windows 10 or 11 (64-bit) and an internet connection.

## What's inside

- **Search** songs, albums and artists with live suggestions, result filters, paging, and an artist
  card with **Shuffle** and **Mix**.
- **Home** with mood pills (Relax, Romance, Feel Good, Party, Energize, Focus, Sad, Workout),
  *Listen again*, *Quick picks*, *Albums for you*, and a radio seeded from what you actually listen to.
- **Player** with stream prefetch and cover crossfade, an **Up next** queue, shuffle / repeat, and
  **karaoke-style synced lyrics** with a fullscreen view.
- **Library** page with Playlists / Songs / Albums / Artists tabs and *Recently played* or *A–Z* sorting.
- **Liked music**, liked albums, playlists you can create, rename, pin and delete, plus listening history.
- **Downloads** — save a track as an audio file with clean, Windows-safe file names.
- **Appearance** — graphics level (Low / Medium / High), text size (100–115%), and an ambient wash
  tinted by the current album art.
- A **mini player** that appears once something is playing, and a fullscreen-able window.

## Your stuff stays on your PC

Liked songs, liked albums, playlists, recently played, the theme, the graphics level and the text
size are stored **locally on your machine only**. Nothing is sent anywhere except the requests that
fetch the music you asked for. Downloading a track saves it to your normal Windows **Downloads**
folder.

## If something isn't working

| What you see | What to do |
| --- | --- |
| *"Windows protected your PC"* on first launch | **More info → Run anyway** — the app just isn't code-signed. |
| *"Port 3000 is being used by another program"* | Close the other program (often a second copy of Svara — installed *and* portable, say) and open the app again. |
| A track won't play, or search comes back empty | YouTube changes things on its side now and then. Grab the newest build from [Releases](https://github.com/Shubham0743X/Svara/releases/latest) — fixes land there. |
| Music plays but downloads fail | Same as above: update to the newest release, then try again. |

Updating: install the newer `Svara-Setup-<version>.exe` over the top and your library, theme and
settings all carry across.

## About

Svara is a personal project by **Shubham Nag**.

Audio and artwork come from YouTube. Svara is **not affiliated with, endorsed by or sponsored by
YouTube or Google**, and anything you download is your own responsibility under YouTube's Terms of
Service.

The app's **code** is [MIT licensed](LICENSE). The **bundled UI fonts are third-party and are not
covered by MIT** — see [`fonts/COPYRIGHT.txt`](fonts/COPYRIGHT.txt).
