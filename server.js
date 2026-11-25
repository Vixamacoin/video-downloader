// Video Downloader — standalone, free, self-hostable.
// Paste a TikTok, Facebook, or Instagram link and download the video itself.
// No login, no database, no API keys, no paid services.
// Video info is resolved with yt-dlp (bundled in ./bin, or installed on the host).

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_RESOLVES_PER_MINUTE = 10; // per IP, keeps a free host from getting hammered
const MAX_CONCURRENT_RESOLVES = 3;
const RESOLVE_TIMEOUT_MS = 60000;
const DOWNLOAD_TIMEOUT_MS = 120000;
const DOWNLOAD_MAX_BYTES = 500 * 1024 * 1024; // 500 MB cap

// ---------------------------------------------------------------------------
// yt-dlp location: env var wins, then the bundled binary, then common spots.
// ---------------------------------------------------------------------------
function findYtDlp() {
  const home = process.env.HOME || '';
  const candidates = [
    process.env.YT_DLP_PATH,
    path.join(__dirname, 'bin', 'yt-dlp'),
    path.join(__dirname, '.venv', 'bin', 'yt-dlp'),
    home ? path.join(home, '.local', 'bin', 'yt-dlp') : null,
    'yt-dlp', // on PATH
  ].filter(Boolean);
  for (const c of candidates) {
    if (c === 'yt-dlp') return c;
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    } catch (_) { /* keep looking */ }
  }
  return 'yt-dlp';
}
const YT_DLP = findYtDlp();

// Check yt-dlp is usable at startup (log only — the server still starts).
execFile(YT_DLP, ['--version'], { timeout: 15000 }, (err, stdout) => {
  if (err) {
    console.warn('[warn] yt-dlp not working at', YT_DLP, '-', (err.message || '').split('\n')[0]);
    console.warn('[warn] Install it: pip install yt-dlp, or put the binary in ./bin/yt-dlp');
  } else {
    console.log('[ok] yt-dlp', String(stdout).trim(), 'at', YT_DLP);
  }
});

// ---------------------------------------------------------------------------
// URL validation — only the three supported platforms, nothing else.
// ---------------------------------------------------------------------------
const ALLOWED_HOSTS = [
  /(^|\.)tiktok\.com$/,
  /^vm\.tiktok\.com$/,
  /^vt\.tiktok\.com$/,
  /(^|\.)facebook\.com$/,
  /^fb\.watch$/,
  /(^|\.)fb\.com$/,
  /(^|\.)instagram\.com$/,
  /^instagr\.am$/,
];

function platformOf(hostname) {
  const h = hostname.toLowerCase();
  if (h.endsWith('tiktok.com')) return 'TikTok';
  if (h.endsWith('facebook.com') || h === 'fb.watch' || h.endsWith('fb.com')) return 'Facebook';
  if (h.endsWith('instagram.com') || h === 'instagr.am') return 'Instagram';
  return null;
}

function validateVideoUrl(raw) {
  if (!raw || typeof raw !== 'string') return { error: 'Paste a link first.' };
  let u;
  try {
    u = new URL(raw.trim());
  } catch (_) {
    return { error: 'That does not look like a link. Copy the full link from the app and paste it here.' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { error: 'That does not look like a link. Copy the full link from the app and paste it here.' };
  }
  const host = u.hostname.toLowerCase();
  if (!ALLOWED_HOSTS.some((re) => re.test(host))) {
    return { error: 'Only TikTok, Facebook, and Instagram links work here.' };
  }
  const platform = platformOf(host);
  // Reject bare profile / home pages — we need one specific video.
  const p = u.pathname.replace(/\/+$/, '');
  const hasVideoPath =
    /\/video\/\d+/.test(p) || /\/photo\/\d+/.test(p) || // TikTok
    /\/reel\/[^/]+/.test(p) || /\/videos\/[^/]+/.test(p) || // Facebook
    /\/watch/.test(p) || /\/share\/[vr]\/[^/]+/.test(p) ||
    /\/p\/[^/]+/.test(p) || /\/reels?\/[^/]+/.test(p) || /\/tv\/[^/]+/.test(p); // Instagram
  const isShortLink = host === 'vm.tiktok.com' || host === 'vt.tiktok.com' ||
    host === 'fb.watch' || host === 'instagr.am' || /\/t\/[^/]+/.test(p);
  if (!hasVideoPath && !isShortLink) {
    return { error: 'That link points to a profile or a page, not one video. Open the video itself, then copy its link.' };
  }
  return { url: u.toString(), platform };
}

// ---------------------------------------------------------------------------
// Resolve a link with yt-dlp -> video info + downloadable formats.
// ---------------------------------------------------------------------------
let activeResolves = 0;
const rateLimit = new Map(); // ip -> [timestamps]

function rateLimited(ip) {
  const now = Date.now();
  const hits = (rateLimit.get(ip) || []).filter((t) => now - t < 60000);
  hits.push(now);
  rateLimit.set(ip, hits);
  return hits.length > MAX_RESOLVES_PER_MINUTE;
}

function friendlyError(stderr, code) {
  const s = (stderr || '').toLowerCase();
  if (code === 'ETIMEDOUT' || s.includes('timed out')) {
    return 'That took too long — the platform may be slow right now. Please try again.';
  }
  if (s.includes('private') || s.includes('login required') || s.includes('log in') ||
      s.includes('cookies') || s.includes('rate-limit') || s.includes('rate limit')) {
    return 'This video cannot be downloaded — it may be private, need a login, or the platform is blocking downloads right now. Only public videos work.';
  }
  if (s.includes('unsupported url') || s.includes('no video formats') || s.includes('unable to extract')) {
    return 'No video was found at that link. Check the link is a public video and try again.';
  }
  if (s.includes('not available') || s.includes('removed') || s.includes('deleted') || s.includes('404')) {
    return 'This video is not available — it may have been deleted or made private.';
  }
  if (s.includes('sign in to confirm') || s.includes('bot')) {
    return 'The platform blocked this request for now. Please try again in a little while.';
  }
  return 'Something went wrong fetching that video. Please check the link and try again.';
}

function pickFormats(info, platform) {
  // Keep only files that have BOTH video and audio. yt-dlp also lists
  // video-only DASH streams (acodec 'none') — those would download silent.
  // Formats with unknown codecs (null) are the platforms' progressive MP4
  // files, which do include audio (e.g. Facebook hd/sd, Instagram 1/2/3).
  // TikTok's "download" format has the TikTok logo baked in — never offer
  // it. The play-API formats are the clean copy, with no watermark.
  const combined = (info.formats || []).filter(
    (f) => f.url && f.ext === 'mp4' && f.vcodec !== 'none' && f.acodec !== 'none' &&
      !(platform === 'TikTok' && (f.format_id === 'download' || f.format_note === 'watermarked'))
  );
  const byKey = new Map();
  for (const f of combined) {
    let key;
    if (f.height) {
      key = `h${f.height}`;
    } else if (platform === 'Facebook' && (f.format_id === 'hd' || f.format_id === 'sd')) {
      key = `fb:${f.format_id}`; // HD and SD are real, different files
    } else {
      key = 'std'; // height-less mirrors of the same file — keep one
    }
    const prev = byKey.get(key);
    if (!prev || (f.tbr || 0) > (prev.tbr || 0) || (f.quality || 0) > (prev.quality || 0)) {
      byKey.set(key, f);
    }
  }
  const list = [...byKey.values()]
    .sort((a, b) => (b.height || 0) - (a.height || 0) || (b.quality || 0) - (a.quality || 0))
    .slice(0, 4)
    .map((f) => {
      let label;
      if (f.height) label = `${f.height}p`;
      else if (platform === 'Facebook' && f.format_id === 'hd') label = 'HD';
      else if (platform === 'Facebook' && f.format_id === 'sd') label = 'SD';
      else label = 'Video';
      let note = '';
      // Every TikTok format offered here is the clean copy — the
      // watermarked one is filtered out above, never shown.
      if (platform === 'TikTok') note = 'no watermark';
      return {
        id: f.format_id,
        label,
        note,
        height: f.height || null,
        url: f.url,
      };
    });
  return list;
}

// Free no-watermark lookup for TikTok. TikTok often blocks the video
// servers of hosting providers outright, so yt-dlp itself can fail there
// even though it works elsewhere — when that happens this service (which
// fetches TikTok from its own side) is the way in. Returns the tikwm data
// object (play = no-watermark file, plus title/author/cover), or null.
// Only the video link is sent; no account and no key.
function fetchTikTokNoWatermark(videoUrl) {
  return new Promise((resolve) => {
    const api = `https://www.tikwm.com/api/?url=${encodeURIComponent(videoUrl)}`;
    const req = https.get(api, { timeout: 15000, headers: { 'User-Agent': 'VideoDownloader/1.0' } }, (up) => {
      let body = '';
      up.on('data', (c) => { body += c; if (body.length > 2 * 1024 * 1024) req.destroy(); });
      up.on('end', () => {
        try {
          const d = JSON.parse(body);
          const data = d && d.data;
          resolve(data && typeof data.play === 'string' && data.play.startsWith('http') ? data : null);
        } catch (_) { resolve(null); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

// Build a resolve result from the tikwm no-watermark data, used when
// yt-dlp cannot fetch the video at all from this server.
function tikTokFallbackResult(tk, videoUrl) {
  const base = `${(tk.author && tk.author.nickname) || 'video'}_${tk.id || 'video'}`
    .replace(/[^\w\-]+/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 80);
  const filename = `${base}.mp4`;
  const referer = Buffer.from(videoUrl).toString('base64url');
  return {
    ok: true,
    platform: 'TikTok',
    title: tk.title || 'Video',
    author: (tk.author && tk.author.nickname) || '',
    authorHandle: (tk.author && tk.author.unique_id) || '',
    thumbnail: tk.cover || null,
    duration: tk.duration || null,
    previewUrl: tk.play,
    filename,
    formats: [{
      id: 'tiktok-nowm',
      label: 'Video',
      note: 'no watermark',
      height: null,
      directUrl: tk.play,
      downloadPath: `/api/download?u=${Buffer.from(tk.play).toString('base64url')}&f=${encodeURIComponent(filename)}&r=${referer}`,
    }],
  };
}

function safeFilename(info) {
  const base = `${info.uploader || 'video'}_${info.id || 'video'}`
    .replace(/[^\w\-]+/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 80);
  return `${base}.mp4`;
}

function resolveVideo(rawUrl) {
  return new Promise((resolve) => {
    const checked = validateVideoUrl(rawUrl);
    if (checked.error) return resolve({ error: checked.error });
    const { url, platform } = checked;

    const args = ['--no-playlist', '-J', '--no-warnings', '--socket-timeout', '30', url];
    const child = execFile(YT_DLP, args, { timeout: RESOLVE_TIMEOUT_MS, maxBuffer: 20 * 1024 * 1024 }, async (err, stdout, stderr) => {
      if (err) {
        // TikTok often blocks this server's network entirely, so yt-dlp
        // fails before it even gets the video. Try the no-watermark
        // service instead — it fetches TikTok from its own side.
        if (platform === 'TikTok') {
          const tk = await fetchTikTokNoWatermark(url);
          if (tk) return resolve(tikTokFallbackResult(tk, url));
        }
        const killed = err.killed ? 'ETIMEDOUT' : null;
        return resolve({ error: friendlyError(stderr || err.message, killed) });
      }
      let info;
      try {
        info = JSON.parse(stdout);
      } catch (_) {
        return resolve({ error: 'Could not read the video details. Please try again.' });
      }
      if (platform === 'TikTok') {
        // TikTok's own video servers refuse this host, so the files yt-dlp
        // finds cannot be fetched by the server — only listed. The
        // no-watermark service's copy lives on a host the server can
        // reach, so use it first. If it has nothing, fall through to the
        // yt-dlp files (the visitor's own browser can usually open those
        // directly, even when the server cannot).
        let tk = await fetchTikTokNoWatermark(url);
        if (!tk) {
          // The free service hiccups sometimes — one retry before giving up.
          await new Promise((r) => setTimeout(r, 1500));
          tk = await fetchTikTokNoWatermark(url);
        }
        if (tk) return resolve(tikTokFallbackResult(tk, url));
      }
      const formats = pickFormats(info, platform);
      if (!formats.length) {
        return resolve({ error: 'No downloadable video was found at that link. It may be a photo post, a private post, or blocked.' });
      }
      const best = formats[0];
      // TikTok's CDN checks the Referer — pass the video page URL along so
      // the download proxy can send it, exactly like yt-dlp does.
      const referer = Buffer.from(info.webpage_url || url).toString('base64url');
      resolve({
        ok: true,
        platform,
        title: info.title || 'Video',
        author: info.uploader || info.channel || '',
        authorHandle: info.uploader_id || '',
        thumbnail: info.thumbnail || null,
        duration: info.duration || null,
        previewUrl: best.url,
        filename: safeFilename(info),
        formats: formats.map((f) => ({
          id: f.id,
          label: f.label,
          note: f.note,
          height: f.height,
          // The browser never sees the raw CDN link for the main Save button;
          // it goes through /api/download. directUrl is the fallback: if the
          // server's network is blocked by the platform's CDN, the visitor's
          // own browser can usually still open the file directly.
          directUrl: f.url,
          downloadPath: `/api/download?u=${Buffer.from(f.url).toString('base64url')}&f=${encodeURIComponent(safeFilename(info))}&r=${referer}`,
        })),
      });
    });
    child.on('error', () => resolve({ error: 'The downloader tool is not available on this server. (yt-dlp missing)' }));
  });
}

// ---------------------------------------------------------------------------
// Download proxy — streams a CDN file to the visitor as an attachment.
// Only hosts on the allowlist are ever fetched (no open proxy / SSRF).
// ---------------------------------------------------------------------------
const DOWNLOAD_HOSTS = [
  /(^|\.)tiktokcdn\.com$/,
  /(^|\.)tiktokcdn-us\.com$/,
  /(^|\.)tiktok\.com$/,
  /(^|\.)tikwm\.com$/,
  /(^|\.)fbcdn\.net$/,
  /(^|\.)cdninstagram\.com$/,
  /(^|\.)instagram\.com$/,
];

function fetchAndStream(fileUrl, res, filename, referer, redirectsLeft = 3) {
  let u;
  try {
    u = new URL(fileUrl);
  } catch (_) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Bad download link.' }));
  }
  if (!DOWNLOAD_HOSTS.some((re) => re.test(u.hostname.toLowerCase()))) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'That file host is not allowed.' }));
  }
  const lib = u.protocol === 'https:' ? https : http;
  // Send browser-like headers: some CDNs (notably TikTok's) refuse requests
  // without a Referer or a real browser User-Agent.
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Accept-Language': 'en-us,en;q=0.5',
  };
  if (referer) headers['Referer'] = referer;
  const req = lib.get(u, { timeout: DOWNLOAD_TIMEOUT_MS, headers }, (up) => {
    if ((up.statusCode === 301 || up.statusCode === 302 || up.statusCode === 303 || up.statusCode === 307 || up.statusCode === 308) && up.headers.location && redirectsLeft > 0) {
      up.resume();
      return fetchAndStream(new URL(up.headers.location, u).toString(), res, filename, referer, redirectsLeft - 1);
    }
    if (up.statusCode !== 200) {
      up.resume();
      res.writeHead(502, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'The video file could not be fetched. The link may have expired — please resolve it again.' }));
    }
    let sent = 0;
    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Content-Disposition': `attachment; filename="${filename.replace(/["\r\n]/g, '')}"`,
      ...(up.headers['content-length'] ? { 'Content-Length': up.headers['content-length'] } : {}),
    });
    up.on('data', (chunk) => {
      sent += chunk.length;
      if (sent > DOWNLOAD_MAX_BYTES) {
        up.destroy();
        req.destroy();
        try { res.end(); } catch (_) {}
      }
    });
    up.on('error', () => { try { res.end(); } catch (_) {} });
    up.pipe(res);
  });
  req.on('timeout', () => req.destroy(new Error('download timed out')));
  req.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'The download failed. Please try again.' }));
    } else {
      try { res.end(); } catch (_) {}
    }
  });
}

// ---------------------------------------------------------------------------
// HTTP server: static frontend + API.
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function serveStatic(reqPath, res) {
  const file = reqPath === '/' ? 'index.html' : reqPath.replace(/^\/+/, '');
  const full = path.join(PUBLIC_DIR, file);
  if (!full.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); return res.end('Forbidden');
  }
  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const ip = req.socket.remoteAddress || 'unknown';

  if (req.method === 'GET' && parsed.pathname === '/api/health') {
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'POST' && parsed.pathname === '/api/resolve') {
    if (rateLimited(ip)) return sendJson(res, 429, { error: 'Too many requests — please wait a minute and try again.' });
    if (activeResolves >= MAX_CONCURRENT_RESOLVES) {
      return sendJson(res, 503, { error: 'Busy right now — please try again in a few seconds.' });
    }
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 10000) req.destroy();
    });
    req.on('end', async () => {
      let data = {};
      try { data = JSON.parse(body || '{}'); } catch (_) { /* handled below */ }
      activeResolves += 1;
      try {
        const result = await resolveVideo(data.url);
        sendJson(res, result.ok ? 200 : 400, result);
      } finally {
        activeResolves -= 1;
      }
    });
    return;
  }

  if (req.method === 'GET' && parsed.pathname === '/api/download') {
    const encoded = parsed.searchParams.get('u');
    const filename = (parsed.searchParams.get('f') || 'video.mp4').replace(/[^A-Za-z0-9._-]/g, '_');
    if (!encoded) return sendJson(res, 400, { error: 'Missing download link.' });
    let fileUrl;
    try {
      fileUrl = Buffer.from(encoded, 'base64url').toString('utf8');
    } catch (_) {
      return sendJson(res, 400, { error: 'Bad download link.' });
    }
    let referer = '';
    const encodedReferer = parsed.searchParams.get('r');
    if (encodedReferer) {
      try { referer = Buffer.from(encodedReferer, 'base64url').toString('utf8'); } catch (_) { /* no referer */ }
    }
    return fetchAndStream(fileUrl, res, filename, referer);
  }

  if (req.method === 'GET') return serveStatic(parsed.pathname, res);

  res.writeHead(405, { 'Content-Type': 'text/plain' });
  res.end('Method not allowed');
});

server.listen(PORT, () => {
  console.log(`Video Downloader running at http://localhost:${PORT}`);
});
