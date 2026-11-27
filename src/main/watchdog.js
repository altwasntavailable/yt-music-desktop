'use strict';

/**
 * Out-of-process watchdog.
 *
 * The app's main process can occasionally stop responding (Windows logs this
 * as an AppHangB1). A watchdog running inside that process cannot help, so the
 * main process spawns this script as a detached Node process using Electron's
 * ELECTRON_RUN_AS_NODE mode.
 *
 * The main process writes a heartbeat every five seconds. If it goes stale for
 * long enough, this process terminates the app and starts it again.
 */

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const TICK_MS = 5000;
const HEARTBEAT_STALE_MS = 30000;
const CONFIRM_MS = 10000;
const RESTART_WINDOW_MS = 10 * 60 * 1000;
const RESTART_LIMIT = 3;
const LOG_MAX_BYTES = 256 * 1024;
const LONG_GAP_MS = 20000;

const args = process.argv.slice(2);
const daemonMode = args.includes('--daemon');
const cleanArgs = args.filter((value) => value !== '--daemon');
const targetPid = Number(cleanArgs[0]) || 0;
const exePath = cleanArgs[1] || '';
const heartbeatPath = cleanArgs[2] || '';
const encodedAppArgs = cleanArgs[3] || '';
let appCwd = cleanArgs[4] || path.dirname(exePath);
try {
  if (!fs.statSync(appCwd).isDirectory()) appCwd = path.dirname(exePath);
} catch {
  appCwd = path.dirname(exePath);
}

if (!targetPid || !exePath || !heartbeatPath) {
  process.exit(0);
}

const stateDir = path.dirname(heartbeatPath);

// Detach one more level so a `taskkill /T` against the Electron process tree
// cannot take the watchdog down with the app.
if (!daemonMode) {
  try {
    const child = spawn(process.execPath, [
      __filename,
      ...cleanArgs,
      '--daemon'
    ], {
      cwd: process.cwd(),
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: process.env
    });
    child.unref();
  } catch (error) {
    try {
      fs.mkdirSync(stateDir, { recursive: true });
      fs.appendFileSync(
        path.join(stateDir, 'watchdog.log'),
        `${new Date().toISOString()} [watchdog launcher ${process.pid}] could not start daemon: ${error.message}\n`,
        'utf8'
      );
    } catch {}
  }
  process.exit(0);
}

let appArgs = [];
try {
  appArgs = JSON.parse(Buffer.from(encodedAppArgs, 'base64').toString('utf8'));
} catch {
  appArgs = [];
}
if (!Array.isArray(appArgs)) appArgs = [];

const logPath = path.join(stateDir, 'watchdog.log');
const restartPath = path.join(stateDir, 'watchdog-restarts.json');
const startedAt = Date.now();
let lastTickAt = startedAt;
let staleSince = 0;
let relaunching = false;

function appendLog(message) {
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    try {
      const stat = fs.statSync(logPath);
      if (stat.size > LOG_MAX_BYTES) {
        try {
          fs.unlinkSync(`${logPath}.old`);
        } catch {
          // There may not be an old log.
        }
        fs.renameSync(logPath, `${logPath}.old`);
      }
    } catch {
      // The log may not exist yet.
    }
    fs.appendFileSync(
      logPath,
      `${new Date().toISOString()} [watchdog ${process.pid}] ${message}\n`,
      'utf8'
    );
  } catch {
    // Logging must never take the watchdog down.
  }
}

function readHeartbeat() {
  try {
    return JSON.parse(fs.readFileSync(heartbeatPath, 'utf8'));
  } catch {
    return null;
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code === 'EPERM');
  }
}

function readRestartHistory() {
  const now = Date.now();
  try {
    const value = JSON.parse(fs.readFileSync(restartPath, 'utf8'));
    if (!Array.isArray(value)) return [];
    return value
      .map((time) => Number(time))
      .filter((time) => Number.isFinite(time) && now - time < RESTART_WINDOW_MS);
  } catch {
    return [];
  }
}

function recordRestart() {
  const history = readRestartHistory();
  history.push(Date.now());
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(restartPath, JSON.stringify(history), 'utf8');
  } catch {
    // The in-memory history is still useful for this run.
  }
  return history.length;
}

function terminateApp() {
  appendLog(`terminating unresponsive app pid ${targetPid}`);
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/PID', String(targetPid), '/T', '/F'], {
        windowsHide: true,
        timeout: 15000
      });
    } catch (error) {
      appendLog(`taskkill failed: ${error.message}`);
    }
  }
  try {
    process.kill(targetPid, 'SIGKILL');
  } catch {
    // It may already be gone.
  }
}

function relaunchApp() {
  if (relaunching) return;
  relaunching = true;

  if (isAlive(targetPid)) {
    appendLog('app is still alive after termination; not relaunching');
    process.exit(0);
  }

  const restartCount = recordRestart();
  if (restartCount > RESTART_LIMIT) {
    appendLog(
      `not relaunching: ${restartCount} restarts within ${Math.round(RESTART_WINDOW_MS / 60000)} minutes`
    );
    process.exit(0);
  }

  appendLog(`relaunching app (restart ${restartCount}/${RESTART_LIMIT})`);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  try {
    const child = spawn(exePath, appArgs, {
      cwd: appCwd,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      env
    });
    child.unref();
    appendLog(`relaunched app, child pid ${child.pid || 'unknown'}`);
  } catch (error) {
    appendLog(`relaunch failed: ${error.message}`);
  }

  setTimeout(() => process.exit(0), 1000);
}

function tick() {
  const now = Date.now();
  const gap = now - lastTickAt;
  lastTickAt = now;

  // The whole machine was asleep/hibernating, or this process was frozen.
  // Give the app a fresh window to write a heartbeat before judging it.
  if (gap > LONG_GAP_MS) {
    appendLog(`long watchdog gap (${gap}ms); resetting stale timer`);
    staleSince = 0;
    return;
  }

  const heartbeat = readHeartbeat();

  if (heartbeat && heartbeat.stopping) {
    appendLog('app reported a normal quit; exiting');
    process.exit(0);
  }

  if (heartbeat && Number(heartbeat.pid) && Number(heartbeat.pid) !== targetPid) {
    appendLog(`heartbeat belongs to pid ${heartbeat.pid}; a new instance is running`);
    process.exit(0);
  }

  if (!isAlive(targetPid)) {
    appendLog('app process is gone; exiting');
    process.exit(0);
  }

  const lastBeat = heartbeat && Number(heartbeat.time) ? Number(heartbeat.time) : startedAt;
  if (now - lastBeat < HEARTBEAT_STALE_MS) {
    staleSince = 0;
    return;
  }

  if (!staleSince) {
    staleSince = now;
    appendLog(
      `heartbeat stale for ${Math.round((now - lastBeat) / 1000)}s; waiting for confirmation`
    );
    return;
  }

  if (now - staleSince < CONFIRM_MS) return;

  appendLog(`main process unresponsive for ${Math.round((now - lastBeat) / 1000)}s`);
  terminateApp();
  setTimeout(relaunchApp, 1500);
}

setTimeout(tick, 1000);
setInterval(tick, TICK_MS);
