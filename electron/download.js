"use strict";
/* Small HTTPS helpers: GET JSON, download to a file or a Buffer, with progress.
 * Follows redirects (GitHub API and release URLs redirect to a CDN). No deps. */

const fs = require("fs");
const https = require("https");
const { URL } = require("url");

const UA = "NetSeer";

function request(url, { method = "GET", headers = {}, timeout = 120000 } = {}, onResponse) {
  const u = new URL(url);
  const req = https.request(
    { method, hostname: u.hostname, path: u.pathname + u.search, headers: { "User-Agent": UA, ...headers }, timeout },
    onResponse
  );
  req.on("timeout", () => req.destroy(new Error("timeout")));
  return req;
}

// Resolve redirects, then hand the final response to `onFinal(res)`.
function follow(url, opts, onFinal, onError, depth = 0) {
  if (depth > 5) return onError(new Error("too many redirects"));
  const req = request(url, opts, (res) => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.resume();
      const next = new URL(res.headers.location, url).toString();
      return follow(next, opts, onFinal, onError, depth + 1);
    }
    if (res.statusCode !== 200) {
      res.resume();
      return onError(new Error(`HTTP ${res.statusCode} for ${url}`));
    }
    onFinal(res);
  });
  req.on("error", onError);
  req.end();
}

function getJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    follow(url, { headers: { Accept: "application/json", ...headers } }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }, reject);
  });
}

// Download to `dest`. onProgress(percent:int) is called when Content-Length is known.
function downloadToFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    follow(url, {}, (res) => {
      const total = parseInt(res.headers["content-length"] || "0", 10);
      let got = 0;
      const out = fs.createWriteStream(dest);
      res.on("data", (chunk) => {
        got += chunk.length;
        if (onProgress && total) onProgress(Math.floor((got * 100) / total));
      });
      res.pipe(out);
      out.on("finish", () => out.close(() => resolve(dest)));
      out.on("error", reject);
      res.on("error", reject);
    }, reject);
  });
}

// Download into a Buffer (small files, like the SHA256SUMS text).
function downloadToBuffer(url, onProgress) {
  return new Promise((resolve, reject) => {
    follow(url, {}, (res) => {
      const total = parseInt(res.headers["content-length"] || "0", 10);
      let got = 0;
      const chunks = [];
      res.on("data", (chunk) => {
        chunks.push(chunk);
        got += chunk.length;
        if (onProgress && total) onProgress(Math.floor((got * 100) / total));
      });
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    }, reject);
  });
}

module.exports = { getJson, downloadToFile, downloadToBuffer };
