# Video Downloader

A small free website: paste a TikTok, Facebook, or Instagram link and download
the video itself. No login, no account, no payment, no app to install.

## What it does

- One page, one box: paste a video link, tap **Download video**.
- It shows the video's title, who posted it, and a preview player.
- Tap **Save** and the video file (MP4) downloads to your phone or computer.
- TikTok downloads come without the watermark, always. The watermarked copy
  is never offered; if the clean copy isn't available from the usual source,
  a free no-watermark service is used as a backup. Facebook offers
  HD and SD when available.
- Only **public** videos work. Private, friends-only, deleted, or login-only
  videos can't be downloaded — no tool can do those honestly.

## How it works (the short version)

The page sends your link to the server. The server uses a free open-source tool
called **yt-dlp** to find the video file on the platform's own pages, then
streams it back to you as a download. Nothing is saved on the server, no link
you paste is stored, and no password is ever asked for.

## Run it on your own computer (free)

You need **Node.js** (version 18 or newer) and **Python 3** on the computer.

1. Download or copy this folder to the computer.
2. Open a terminal in the folder.
3. If `bin/yt-dlp` is missing, get yt-dlp one of these ways:
   - **Easiest:** `pip install yt-dlp` (needs Python), or
   - Download the file from https://github.com/yt-dlp/yt-dlp/releases/latest
     (the file named `yt-dlp`), put it in the `bin` folder, and make it
     executable (`chmod +x bin/yt-dlp` on Mac/Linux).
4. Start it: `node server.js`
5. Open http://localhost:3000 in your browser.

There are no extra packages to install — the app uses only Node.js itself.

## Put it on the internet for free (Render)

This is how the site gets a public address anyone can open, at $0.

1. Put this folder on **GitHub** (free account): create a new repository and
   upload these files. (The `render.yaml` file in the folder tells Render
   exactly what to do — you don't need to change anything.)
2. Go to **render.com** and sign up free (you can sign in with GitHub).
3. Click **New + → Web Service**, pick the repository you just made.
4. Render reads `render.yaml` and fills in the settings itself. The plan
   should say **Free**. Click **Create Web Service**.
5. Wait a few minutes while it builds. When it says **Live**, Render gives you
   an address like `https://video-downloader-xxxx.onrender.com` — that's
   your site. Anyone with the address can use it.

**Two honest notes about the free plan:**
- The free service "sleeps" after about 15 minutes with no visitors. The first
  person to open it after that waits ~30–60 seconds while it wakes up. After
  that it's fast.
- Free Render sites get 750 hours a month, which is enough to stay up all
  month for one small site.

## If a video won't download

- **Private or friends-only video:** it will never work, by design.
- **"Took too long" or "blocked":** TikTok, Facebook, and Instagram sometimes
  slow down or block download tools for a while. Wait a bit and try again.
- **"No video found":** check the link opens a single public video (not a
  profile page) and that you copied the whole link.
- **TikTok sometimes blocks the server's network** (its video servers refuse
  some hosting providers). If the Save button fails on a TikTok video, use the
  **"Open the video file directly"** link under the buttons — your own browser
  can usually open it, and you can save it from there.
- **Instagram sometimes blocks more than the others.** If one Instagram link
  fails, try another public one — some posts are blocked by Instagram itself.

## Files in this folder

- `server.js` — the server: serves the page, resolves links with yt-dlp,
  streams downloads.
- `public/index.html` — the whole website page (design + buttons).
- `package.json` — tells hosts how to start the app (`node server.js`).
- `render.yaml` — the free-hosting setup for Render.
- `requirements.txt` — fallback way to install yt-dlp on Python-based hosts.
- `bin/yt-dlp` — the downloader tool itself (downloaded at build time on
  Render; already included here for local use).

## Cost

$0. Node.js, yt-dlp, GitHub, and Render's free tier are all free. There are no
API keys and no paid services anywhere in this app.
