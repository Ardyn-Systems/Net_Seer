"use strict";
/* Install a specific NetSeer release (rollback / reinstall / a chosen version).
 *
 * electron-updater handles the automatic "update to the newest" path. This covers the version list:
 * it downloads a chosen release's installer/AppImage from GitHub, verifies its SHA-256 against the
 * release's SHA256SUMS, and runs it. (Keeping the SHA-256 check is a NetSeer invariant.) */

const os = require("os");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { getJson, downloadToFile, downloadToBuffer } = require("./download");

const REPO = "Ardyn-Systems/Net_Seer";
const norm = (v) => (v || "").replace(/[^0-9.]/g, "");

function platformAsset(assets) {
  if (process.platform === "win32") {
    return assets.find((a) => /setup/i.test(a.name) && a.name.toLowerCase().endsWith(".exe")) || null;
  }
  if (process.platform === "linux") {
    return assets.find((a) => a.name.toLowerCase().endsWith(".appimage")) || null;
  }
  return null;
}

function sumsAssetFor(assets) {
  const want = process.platform === "win32" ? "windows" : process.platform === "linux" ? "linux" : null;
  if (!want) return null;
  return assets.find((a) => /sha256sums/i.test(a.name) && a.name.toLowerCase().includes(want)) || null;
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    const s = fs.createReadStream(file);
    s.on("error", reject);
    s.on("data", (d) => h.update(d));
    s.on("end", () => resolve(h.digest("hex")));
  });
}

// Find a filename's expected hash in a SHA256SUMS file ("<hex>  name" / "<hex> *name").
function expectedHash(sumsText, filename) {
  for (const line of (sumsText || "").split(/\r?\n/)) {
    const m = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
    if (m && m[2].trim() === filename) return m[1].toLowerCase();
  }
  return null;
}

// Every published release (newest first), each tagged with whether this OS has an asset.
async function listReleases() {
  const arr = await getJson(`https://api.github.com/repos/${REPO}/releases?per_page=40`);
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((d) => !d.draft)
    .map((d) => {
      const assets = (d.assets || []).map((a) => ({ name: a.name, url: a.browser_download_url, size: a.size || 0 }));
      const asset = platformAsset(assets);
      return {
        tag: d.tag_name || "",
        version: norm(d.tag_name || ""),
        name: d.name || d.tag_name || "",
        body: d.body || "",
        url: d.html_url || "",
        date: d.published_at || d.created_at || "",
        prerelease: !!d.prerelease,
        hasAsset: !!asset,
        size: asset ? asset.size : 0,
        assets,
      };
    });
}

// Download a specific release's asset for this OS and verify its SHA-256. Resolves to the staged
// path; throws a user-facing message. progress(status, pct): status is "downloading" | "verifying".
async function prepare(tag, progress) {
  const releases = await listReleases();
  const rel = releases.find((r) => r.tag === tag || r.version === norm(tag));
  if (!rel) throw new Error("That version isn't on GitHub anymore.");
  const asset = platformAsset(rel.assets);
  if (!asset) throw new Error("No download is available for this platform.");
  if (progress) progress("downloading", 0);
  const dest = path.join(os.tmpdir(), asset.name);
  await downloadToFile(asset.url, dest, (p) => progress && progress("downloading", p));
  let verified = false;
  const sums = sumsAssetFor(rel.assets);
  if (sums) {
    if (progress) progress("verifying", 100);
    const want = expectedHash((await downloadToBuffer(sums.url)).toString("utf8"), asset.name);
    if (want) {
      const got = await sha256File(dest);
      if (got !== want) {
        try { fs.unlinkSync(dest); } catch { /* ignore */ }
        throw new Error("The download's checksum didn't match — it may be corrupted. Try again.");
      }
      verified = true;
    }
  }
  if (process.platform !== "win32") {
    try { fs.chmodSync(dest, 0o755); } catch { /* ignore */ }
  }
  return { path: dest, tag: rel.tag, version: rel.version, verified };
}

// Run a staged installer, then the caller quits so it can replace files and relaunch.
//  - Windows: run the NSIS installer silently (/S) and relaunch. /S doesn't auto-launch, so a short
//    wait (lets this instance quit and release the exe), the silent install, then a start of our exe.
//  - Linux: launch the downloaded AppImage (the chosen version) detached.
function applyInstaller(dest, appExe) {
  if (process.platform === "win32" && dest.toLowerCase().endsWith(".exe")) {
    const exe = appExe || process.execPath;
    const line = `ping -n 2 127.0.0.1 >nul & "${dest}" /S & start "" "${exe}"`;
    spawn("cmd.exe", ["/c", line], { detached: true, stdio: "ignore", windowsVerbatimArguments: true }).unref();
    return true;
  }
  spawn(dest, [], { detached: true, stdio: "ignore" }).unref();
  return true;
}

module.exports = { listReleases, platformAsset, sumsAssetFor, expectedHash, prepare, applyInstaller };
