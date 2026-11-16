import { app, BrowserWindow, ipcMain, Menu, session, shell, type IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import { Core } from './main/core';
import { generateGuides, GuideTool } from './main/guides';
import type { GuideImportResult, GuideProgress } from './shared/types';

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) app.quit();

if (!app.requestSingleInstanceLock()) app.quit();

let mainWindow: BrowserWindow | null = null;
// Development runs only: D2CS_DATA_DIR keeps snapshot and backups apart,
// D2CS_STEAM_PATH points at a copy of a Steam folder. Ignored in the packaged app.
const devEnv = (name: string) => (!app.isPackaged && process.env[name]) || undefined;
const core = new Core({
  dataDir: devEnv('D2CS_DATA_DIR') ?? app.getPath('userData'),
  steamPath: devEnv('D2CS_STEAM_PATH'),
});

const devUrl = MAIN_WINDOW_VITE_DEV_SERVER_URL;
const indexFile = path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`);

/** Only answer IPC from our own page in the main frame. */
function fromOurPage(e: IpcMainInvokeEvent): boolean {
  const frame = e.senderFrame;
  if (!frame || frame !== e.sender.mainFrame) return false;
  const url = frame.url;
  if (devUrl) return url.startsWith(devUrl);
  try {
    return new URL(url).protocol === 'file:' && path.resolve(decodeURIComponent(new URL(url).pathname.slice(1))) === path.resolve(indexFile);
  } catch {
    return false;
  }
}

function handle(channel: string, fn: (...args: unknown[]) => Promise<unknown>) {
  handleWithSender(channel, (_e, ...args) => fn(...args));
}

function handleWithSender(channel: string, fn: (e: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>) {
  ipcMain.handle(channel, async (e, ...args) => {
    if (!fromOurPage(e)) throw new Error('Blocked');
    return fn(e, ...args);
  });
}

const guideTool = new GuideTool();
let guideImport: AbortController | null = null;

/** Generate every hero's guides with d2pt-guides, then install them into the targets. */
async function importGuides(e: IpcMainInvokeEvent, targetIds: unknown, options: unknown): Promise<GuideImportResult> {
  if (guideImport) throw new Error('A guide import is already running');
  const targets = Array.isArray(targetIds) ? targetIds.map(String) : [];
  const replace = !!(options && typeof options === 'object' && (options as { replace?: unknown }).replace === true);
  const send = (p: GuideProgress) => {
    if (!e.sender.isDestroyed()) e.sender.send('guideProgress', p);
  };
  const ctrl = new AbortController();
  guideImport = ctrl;
  try {
    const blocked = await core.checkGuideTargets(targets);
    if (blocked) return { ok: false, error: blocked, results: [], generated: 0, heroes: 0 };
    const py = await guideTool.command();
    const guides = await generateGuides(py, { signal: ctrl.signal, onProgress: send });
    send({ phase: 'installing', done: 0, total: 0, label: '', generated: guides.files.size });
    const r = await core.installGuides(targets, guides, replace);
    return { ...r, generated: guides.files.size, heroes: guides.heroes.size };
  } finally {
    guideImport = null;
  }
}

handle('guideToolStatus', () => guideTool.status());
handleWithSender('importGuides', importGuides);
handle('cancelGuideImport', async () => guideImport?.abort());

handle('listAccounts', () => core.listAccounts());
handle('getDiff', (s, t, c) => core.getDiff(s as string, t as string, c as never));
handle('push', (s, t, c) => core.push(s as string, t as string[], c as never));
handle('restore', (b, a) => core.restore(b as string, a as string));

const createWindow = () => {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: 'Dota 2 Config Sync',
    backgroundColor: '#14161a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });

  const wc = mainWindow.webContents;
  // Never navigate away or open new windows; links to the web open in the browser.
  wc.on('will-navigate', (e) => e.preventDefault());
  wc.on('will-redirect', (e) => e.preventDefault());
  wc.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  wc.on('will-attach-webview', (e) => e.preventDefault());

  if (devUrl) {
    void mainWindow.loadURL(devUrl);
    wc.openDevTools({ mode: 'detach' });
  } else {
    void mainWindow.loadFile(indexFile);
  }
};

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  // Block every request that isn't our own files (or the Vite dev server).
  session.defaultSession.webRequest.onBeforeRequest((details, cb) => {
    const u = details.url;
    const ok =
      u.startsWith('file://') ||
      u.startsWith('devtools://') ||
      (!!devUrl && (u.startsWith(devUrl) || u.startsWith(devUrl.replace(/^http/, 'ws'))));
    cb({ cancel: !ok });
  });
  createWindow();
});

app.on('window-all-closed', () => app.quit());
