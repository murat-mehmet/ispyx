// Newer-release check for the panel and `ispyx update`. Asks GitHub which release is the latest (an outgoing HTTPS
// request, no API key, no data sent), at most once a day; config `updateCheck: false` turns it off.
// Updating stays per platform:
//   Windows  `ispyx update`: stop the resident, npm install -g ispyx@latest, start it again (launcher.js)
//   macOS    scripts/install.sh from the latest release: checks and swaps Ispyx.app, then opens it again
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = 'murat-mehmet/ispyx';
export const MAC_INSTALL_URL = `https://github.com/${REPO}/releases/latest/download/install.sh`;
const ENTRY = fileURLToPath(new URL('../server.js', import.meta.url));
const DAY_MS = 24 * 60 * 60 * 1000;

/** 1 when a is newer than b, -1 when older, 0 when equal; "1.2.10" > "1.2.9", a release beats its pre-release. */
export function compareVersions(a, b) {
  const parse = (v) => {
    const [main, pre = ''] = String(v).replace(/^v/, '').split('-', 2);
    return { nums: main.split('.').map((n) => Number(n) || 0), pre };
  };
  const x = parse(a), y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return Math.sign(d);
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre > y.pre ? 1 : -1;
}

/** The version of the latest release, from the redirect of /releases/latest (no API call, so no rate limit). */
export async function latestVersion({ fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  const res = await fetchImpl(`https://github.com/${REPO}/releases/latest`, {
    method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
  });
  const m = /\/releases\/tag\/v?([^/?#]+)$/.exec(res.headers.get('location') ?? '');
  if (!m) throw new Error(`no latest release found (HTTP ${res.status})`);
  return decodeURIComponent(m[1]);
}

/**
 * Checks shortly after start and then once a day. state() is { current, latest, available } once a check has
 * answered, else null; a failed check (offline) keeps the last answer and is retried on the next round.
 */
export function startUpdateCheck({ current, enabled = true, firstDelayMs = 15000, fetchImpl } = {}) {
  let latest = null;
  const check = async () => {
    try { latest = await latestVersion({ fetchImpl }); } catch { /* offline or GitHub down: try again later */ }
  };
  const timers = [];
  if (enabled) {
    const t = setTimeout(check, firstDelayMs);
    const i = setInterval(check, DAY_MS);
    t.unref?.();
    i.unref?.();
    timers.push(t, i);
  }
  return {
    check,
    state: () => (latest ? { current, latest, available: compareVersions(latest, current) > 0 } : null),
    stop: () => { for (const t of timers) clearTimeout(t); },
  };
}

/**
 * Where a running update is, from its log: { step, error } ("Downloading Ispyx 1.0.6 · 45%", "Checking the app").
 * The installer (scripts/install.sh) writes "==> <step>" lines, "Downloaded N%" while downloading and
 * "ispyx: <reason>" when it gives up; `ispyx update` on Windows writes npm's output.
 */
export function readUpdateLog(text) {
  let step = 'Starting', pct = null, error = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    let m;
    if ((m = /^==> (.+)$/.exec(line))) { step = m[1]; pct = null; }
    else if ((m = /^Downloaded (\d+)%$/.exec(line))) pct = Number(m[1]);
    else if ((m = /^ispyx: (.+)$/.exec(line))) error = m[1];
  }
  return { step: pct === null ? step : `${step} \u00b7 ${pct}%`, error };
}

/**
 * Starts the update in a process of its own (the update quits the running ispyx, this process included) and
 * returns at once. Its output goes to update.log in the data directory; progress() reads it.
 */
export function launchUpdate({ platform = process.platform, dataDir }) {
  let out = 'ignore';
  const log = path.join(dataDir, 'update.log');
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    out = fs.openSync(log, 'w');
  } catch { /* no log then */ }
  const child = platform === 'darwin'
    ? spawn('/bin/sh', ['-c', `curl -fsSL ${MAC_INSTALL_URL} | sh`], { detached: true, stdio: ['ignore', out, out] })
    : spawn(process.execPath, [ENTRY, 'update'], { detached: true, windowsHide: true, stdio: ['ignore', out, out] });
  child.on('error', () => {});
  child.unref();
  if (typeof out === 'number') fs.closeSync(out);
  return { progress: () => { try { return readUpdateLog(fs.readFileSync(log, 'utf8')); } catch { return { step: 'Starting', error: null }; } } };
}
