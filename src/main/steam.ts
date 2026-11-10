// Steam install, account discovery, persona names, Steam Cloud status, Dota process check.

import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { kvGet, kvRoot, parseKV, type KVObject } from './kv';
import type { CloudState } from '../shared/types';

const run = promisify(execFile);

export const DEFAULT_STEAM_PATH = 'C:\\Program Files (x86)\\Steam';

export async function findSteamPath(): Promise<string> {
  if (process.platform === 'win32') {
    try {
      const { stdout } = await run('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'], {
        windowsHide: true,
      });
      const m = /SteamPath\s+REG_SZ\s+(.+)/i.exec(stdout);
      if (m) return path.resolve(m[1].trim());
    } catch {
      // fall through to the default
    }
  }
  return DEFAULT_STEAM_PATH;
}

export async function isDotaRunning(): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  const { stdout } = await run('tasklist', ['/FI', 'IMAGENAME eq dota2.exe', '/NH', '/FO', 'CSV'], {
    windowsHide: true,
  });
  return /"dota2\.exe"/i.test(stdout);
}

/** Account IDs (folder names under userdata) that have a Dota 2 (570) folder. */
export async function discoverAccountIds(steamPath: string): Promise<string[]> {
  const userdata = path.join(steamPath, 'userdata');
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(userdata, { withFileTypes: true });
  } catch {
    return [];
  }
  const ids: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || !/^[1-9]\d{0,11}$/.test(e.name)) continue;
    try {
      if ((await fs.lstat(path.join(userdata, e.name, '570'))).isDirectory()) ids.push(e.name);
    } catch {
      // no 570 folder
    }
  }
  return ids.sort((a, b) => Number(a) - Number(b));
}

async function readVdf(file: string): Promise<KVObject | null> {
  try {
    return parseKV(await fs.readFile(file, 'utf8'), { escapes: true });
  } catch {
    return null;
  }
}

export interface AccountMeta {
  name: string;
  cloud: CloudState;
  cloudSyncState: string | null;
}

export async function readAccountMeta(steamPath: string, id: string): Promise<AccountMeta> {
  const base = path.join(steamPath, 'userdata', id);
  const local = await readVdf(path.join(base, 'config', 'localconfig.vdf'));
  const localRoot = local ? kvRoot(local) : undefined;

  const persona = localRoot ? kvGet(localRoot, ['friends', 'PersonaName']) : undefined;
  const name = typeof persona === 'string' && persona.trim() ? persona : `Account ${id}`;

  const shared = await readVdf(path.join(base, '7', 'remote', 'sharedconfig.vdf'));
  const sharedRoot = shared ? kvRoot(shared) : undefined;
  let cloud: CloudState = 'on';
  if (sharedRoot) {
    if (kvGet(sharedRoot, ['Software', 'Valve', 'Steam', 'CloudEnabled']) === '0') cloud = 'off-global';
    else if (kvGet(sharedRoot, ['Software', 'Valve', 'Steam', 'apps', '570', 'cloudenabled']) === '0') cloud = 'off-dota';
  }

  let cloudSyncState: string | null = null;
  if (cloud === 'on' && localRoot) {
    const s = kvGet(localRoot, ['Software', 'Valve', 'Steam', 'apps', '570', 'cloud', 'last_sync_state']);
    if (typeof s === 'string') cloudSyncState = s;
  }
  return { name, cloud, cloudSyncState };
}
