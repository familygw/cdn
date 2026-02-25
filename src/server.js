const http = require("http");
const { Readable } = require("stream");
const fetch = global.fetch ? global.fetch.bind(global) : require("node-fetch");

const HOST = "pi3server.local";

const TELEFE_MASTER_URL =
  "https://telefeappmitelefe1.akamaized.net/hls/live/2037985/appmitelefe/TOK/master.m3u8";

const TELEFE_TOKENIZE_URL = "https://mitelefe.com/vidya/tokenize";

const telefeTokenCache = {
  entryUrl: null,
  baseDirUrl: null,
  tokenQuery: "",
  fetchedAtMs: 0
};

function isProbablyUrl(value) {
  return typeof value === "string" && /^https?:\/\//i.test(value);
}

function extractFirstUrlFromJson(value) {
  if (typeof value === "string") return isProbablyUrl(value) ? value : null;
  if (!value || typeof value !== "object") return null;

  for (const key of ["url", "tokenizedUrl", "tokenized_url", "playbackUrl", "playback_url", "result"]) {
    if (key in value) {
      const candidate = extractFirstUrlFromJson(value[key]);
      if (candidate) return candidate;
    }
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const candidate = extractFirstUrlFromJson(item);
      if (candidate) return candidate;
    }
  }

  for (const k of Object.keys(value)) {
    const candidate = extractFirstUrlFromJson(value[k]);
    if (candidate) return candidate;
  }

  return null;
}

async function getTelefeTokenizedEntryUrl() {
  // Keep the cache short to reduce token-expiry risk.
  const now = Date.now();
  const CACHE_TTL_MS = 60 * 1000;
  if (telefeTokenCache.entryUrl && now - telefeTokenCache.fetchedAtMs < CACHE_TTL_MS) {
    return telefeTokenCache.entryUrl;
  }

  const upstream = await fetch(TELEFE_TOKENIZE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/plain, */*",
      "Origin": "https://mitelefe.com",
      "Referer": "https://mitelefe.com",
      "User-Agent": "Mozilla/5.0"
    },
    body: JSON.stringify({ url: TELEFE_MASTER_URL })
  });

  const contentType = upstream.headers.get("content-type") || "";
  let tokenizedUrl = null;

  if (contentType.includes("application/json")) {
    const json = await upstream.json();
    tokenizedUrl = extractFirstUrlFromJson(json);
  } else {
    const text = await upstream.text();
    try {
      const json = JSON.parse(text);
      tokenizedUrl = extractFirstUrlFromJson(json);
    } catch {
      tokenizedUrl = isProbablyUrl(text.trim()) ? text.trim() : null;
    }
  }

  if (!upstream.ok) {
    throw new Error(`tokenize failed: ${upstream.status}`);
  }
  if (!tokenizedUrl) {
    throw new Error("tokenize did not return a usable url");
  }

  const parsed = new URL(tokenizedUrl);
  const baseDir = new URL(parsed.origin + parsed.pathname.replace(/\/[^\/]*$/, "/"));

  telefeTokenCache.entryUrl = tokenizedUrl;
  telefeTokenCache.baseDirUrl = baseDir.toString();
  telefeTokenCache.tokenQuery = parsed.search || "";
  telefeTokenCache.fetchedAtMs = now;

  return tokenizedUrl;
}

async function getChannelBaseUrl(channel) {
  if (typeof channel.baseUrl === "function") {
    return await channel.baseUrl();
  }
  return channel.baseUrl;
}

function rewriteM3u8(text, { channelKey, baseUrl, rewriteFromUrl, tokenQuery }) {
  // Keep behavior for simple channels (replace absolute baseUrl occurrences)
  // but allow a different rewriteFromUrl (e.g. directory URL derived from tokenized entry URL).
  const rewriteFrom = rewriteFromUrl || baseUrl;

  // Fast-path: original logic for absolute URL replacement.
  if (rewriteFrom) {
    const search = `${rewriteFrom.replace(/\/$/, "")}/`;
    const replace = `http://${HOST}/${channelKey}/`;
    text = text.split(search).join(replace);
  }

  // For tokenized streams, append the token query to relative URIs when missing.
  if (!tokenQuery) return text;

  const lines = text.split(/\r?\n/);
  const out = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return line;

    // Absolute-path on current host: force through our proxy.
    if (trimmed.startsWith("/")) {
      const withToken = trimmed.includes("?") ? trimmed : `${trimmed}${tokenQuery}`;
      return `http://${HOST}/${channelKey}${withToken}`;
    }

    // Relative URI: append token if missing.
    if (!/^https?:\/\//i.test(trimmed)) {
      return trimmed.includes("?") ? trimmed : `${trimmed}${tokenQuery}`;
    }

    return line;
  });

  return out.join("\n");
}

const CHANNELS = {
  canal13: {
    baseUrl: "https://live-01-02-eltrece.vodgc.net/eltrecetv",
    origin: "https://www.eltrecetv.com.ar",
    referer: "https://www.eltrecetv.com.ar/"
  },
  tn: {
    baseUrl: "https://live-01-01-tn.vodgc.net/TN24",
    origin: "https://www.tn.com.ar",
    referer: "https://www.tn.com.ar/"
  },
  telefe: {
    // baseUrl is dynamic: a tokenized URL returned by mitelefe tokenize endpoint.
    baseUrl: async () => await getTelefeTokenizedEntryUrl(),
    origin: "https://mitelefe.com",
    referer: "https://mitelefe.com",
    extraHeaders: {
      "Host": "telefeappmitelefe1.akamaized.net",
      "DNT": "1"
    }
  }
};

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host || HOST}`);
    const parts = requestUrl.pathname.split("/");
    const channelKey = parts[1];
    const channel = CHANNELS[channelKey];

    if (!channel) {
      res.writeHead(404);
      res.end("Unknown channel");
      return;
    }

    const path = requestUrl.pathname.replace(`/${channelKey}`, "");
    const baseUrl = await getChannelBaseUrl(channel);

    let targetUrl;
    if (channelKey === "telefe") {
      // For Telefe, baseUrl is the tokenized entry URL for the master playlist.
      // - If client asks for /telefe/ or /telefe/index.m3u8 or /telefe/master.m3u8, serve entry URL.
      // - Otherwise, proxy to baseDir + path and ensure token query is present.
      const reqPath = path || "/";
      const wantsEntry = reqPath === "/" || reqPath === "/index.m3u8" || reqPath === "/master.m3u8";

      if (wantsEntry) {
        targetUrl = baseUrl;
      } else {
        // Ensure the Telefe cache is populated with baseDir/tokenQuery for this entry.
        if (!telefeTokenCache.baseDirUrl) {
          await getTelefeTokenizedEntryUrl();
        }
        const tokenQuery = requestUrl.search || telefeTokenCache.tokenQuery || "";
        targetUrl = `${telefeTokenCache.baseDirUrl.replace(/\/$/, "")}${reqPath}${tokenQuery}`;
      }
    } else {
      targetUrl = baseUrl + requestUrl.pathname.replace(`/${channelKey}`, "");
      if (requestUrl.search) targetUrl += requestUrl.search;
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
        "Access-Control-Allow-Headers": "*"
      });
      res.end();
      return;
    }

    const upstream = await fetch(targetUrl, {
      headers: {
        "Origin": channel.origin,
        "Referer": channel.referer,
        "User-Agent": req.headers["user-agent"] || "Mozilla/5.0",
        ...(channel.extraHeaders || {})
      }
    });

    const contentType = (upstream.headers.get("content-type") || "").toLowerCase();
    const targetPathname = (() => {
      try {
        return new URL(targetUrl).pathname;
      } catch {
        return "";
      }
    })();

    if (contentType.includes("mpegurl") || targetPathname.endsWith(".m3u8")) {
      // console.log("Found contentType: ", contentType, " - targetUrl: ", targetUrl);
      let text = await upstream.text();
      if (channelKey === "telefe") {
        // Rewrites absolute URLs and appends token query to relative URIs.
        const rewriteFromUrl = telefeTokenCache.baseDirUrl || null;
        const tokenQuery = telefeTokenCache.tokenQuery || "";
        text = rewriteM3u8(text, { channelKey, baseUrl, rewriteFromUrl, tokenQuery });
      } else {
        text = rewriteM3u8(text, { channelKey, baseUrl });
      }

      res.writeHead(200, {
        "Content-Type": "application/vnd.apple.mpegurl",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
        "Access-Control-Allow-Headers": "*",
        "Cache-Control": "no-cache"
      });

      res.end(text);
      return;
    }

    res.writeHead(upstream.status, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": "*"
    });

    const body = upstream.body;
    if (!body) {
      res.end();
      return;
    }

    const nodeStream = typeof body.pipe === "function" ? body : Readable.fromWeb(body);
    nodeStream.on("error", (streamErr) => {
      if (!res.headersSent) {
        res.writeHead(502, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
          "Access-Control-Allow-Headers": "*"
        });
      }
      res.end("Upstream stream error: " + streamErr.message);
    });

    nodeStream.pipe(res);

  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(500, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
        "Access-Control-Allow-Headers": "*"
      });
      res.end("Proxy error: " + err.message);
      return;
    }

    // If headers are already sent, just terminate the response.
    try {
      res.end();
    } catch {
      // Ignore
    }
  }
});

server.listen(3000, () => {
  console.log("IPTV Worker running on port 3000");
});