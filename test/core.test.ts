import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseKV, parseDotaKV, kvGet, kvRoot } from '../src/main/kv';
import { flattenFile, diffFile, fileState } from '../src/main/diff';
import { safeJoin, isNeverCopied } from '../src/main/files';
import { Core } from '../src/main/core';

const KEYS = (bind: string) => `"config"
{
\t"bindings"
\t{
\t\t"\\"\t\t"toggleconsole"
\t\t"SPACE"\t\t"${bind}"
\t}
}
`;
const CONVARS = (v: string) => `"config"\n{\n\t"convars"\n\t{\n\t\t"dota_camera_speed"\t\t"${v}"\n\t}\n}\n`;
const SHARED = (cloud: 'global' | 'dota' | 'on') => `"UserRoamingConfigStore"
{
\t"Software"
\t{
\t\t"Valve"
\t\t{
\t\t\t"Steam"
\t\t\t{
${cloud === 'global' ? '\t\t\t\t"CloudEnabled"\t\t"0"\n' : ''}\t\t\t\t"apps"
\t\t\t\t{
\t\t\t\t\t"570"
\t\t\t\t\t{
${cloud === 'dota' ? '\t\t\t\t\t\t"cloudenabled"\t\t"0"\n' : ''}\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t}
}
`;
const LOCAL = (name: string) =>
  `"UserLocalConfigStore"\n{\n\t"friends"\n\t{\n\t\t"PersonaName"\t\t"${name}"\n\t}\n\t"Software"{"Valve"{"Steam"{"apps"{"570"{"cloud"{"last_sync_state"\t"conflictingchanges"}}}}}}\n\t"blob"\t\t"{\\"a\\":1}"\n}\n`;

async function write(file: string, text: string) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
}

describe('kv parser', () => {
  it('reads the unescaped backslash key used by Dota', () => {
    const obj = parseDotaKV(KEYS('+dota_camera_follow'));
    expect(kvGet(obj, ['config', 'bindings', '\\'])).toBe('toggleconsole');
    expect(kvGet(obj, ['config', 'bindings', 'SPACE'])).toBe('+dota_camera_follow');
  });
  it('reads escaped strings in Steam vdf files', () => {
    const obj = parseKV(LOCAL('Bob'), { escapes: true });
    expect(kvGet(kvRoot(obj)!, ['friends', 'personaname'])).toBe('Bob');
    expect(kvGet(kvRoot(obj)!, ['blob'])).toBe('{"a":1}');
  });
  it('flattens and diffs key by key', () => {
    const a = fileState('remote/user_keys.vcfg', Buffer.from(KEYS('x')));
    const b = fileState('remote/user_keys.vcfg', Buffer.from(KEYS('y')));
    const d = diffFile('remote/user_keys.vcfg', a, b)!;
    expect(d.status).toBe('changed');
    expect(d.changes).toEqual([{ path: ['bindings', 'SPACE'], kind: 'changed', before: 'x', after: 'y' }]);
  });
  it('flattens json', () => {
    const f = flattenFile('a.json', Buffer.from('{"v":3,"c":[{"n":"x"}]}'))!;
    expect(Object.values(f)).toEqual(['3', 'x']);
  });
  it('never stalls on stray characters', () => {
    expect(() => parseKV('"a" "b" x', { escapes: false })).toThrow();
    expect(parseKV('"a"   "b"', { escapes: false })).toEqual([['a', 'b']]);
  });
  it('reads binary KV (VBKV)', () => {
    const body = Buffer.concat([
      Buffer.from([0x00]), Buffer.from('HeroBuildConfig\0'),
      Buffer.from([0x02]), Buffer.from('version\0'), Buffer.from([3, 0, 0, 0]),
      Buffer.from([0x01]), Buffer.from('nyx\0cloud: guides/nyx.build\0'),
      Buffer.from([0x08, 0x08]),
    ]);
    const buf = Buffer.concat([Buffer.from('VBKV'), Buffer.alloc(4), body]);
    expect(flattenFile('remote/cfg/herobuilds.cfg', buf)).toEqual({ version: '3', nyx: 'cloud: guides/nyx.build' });
  });
  it('marks unparseable files', () => {
    const d = diffFile('x.txt', fileState('x.txt', Buffer.from('"a" {')), fileState('x.txt', Buffer.from('"b" {')))!;
    expect(d.unparsed).toBe(true);
  });
});

describe('path safety', () => {
  it('rejects paths that leave the root', () => {
    const root = path.resolve('C:/steam/userdata/1/570');
    expect(() => safeJoin(root, '../730/x')).toThrow();
    expect(() => safeJoin(root, 'C:/Windows/x')).toThrow();
    expect(() => safeJoin(root, 'remote/a.txt:stream')).toThrow();
    expect(safeJoin(root, 'remote/user_keys.vcfg')).toBe(path.join(root, 'remote', 'user_keys.vcfg'));
  });
  it('never copies account-bound files', () => {
    expect(isNeverCopied('local/cfg/user_keys_0_slot0.vcfg_lastclouded')).toBe(true);
    expect(isNeverCopied('remotecache.vdf')).toBe(true);
    expect(isNeverCopied('remote/user_keys.vcfg')).toBe(false);
  });
});

describe('Core on a fake Steam folder', () => {
  let tmp: string;
  let steam: string;
  let data: string;
  let dota = false;
  const acc = (id: string, ...p: string[]) => path.join(steam, 'userdata', id, '570', ...p);

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'd2cs-'));
    steam = path.join(tmp, 'Steam');
    data = path.join(tmp, 'data');
    dota = false;
    const setup: Array<[string, string, 'global' | 'dota' | 'on']> = [
      ['111', 'Alpha', 'global'],
      ['222', 'Beta', 'dota'],
      ['333', 'Gamma', 'on'],
    ];
    for (const [id, name, cloud] of setup) {
      await write(path.join(steam, 'userdata', id, 'config', 'localconfig.vdf'), LOCAL(name));
      await write(path.join(steam, 'userdata', id, '7', 'remote', 'sharedconfig.vdf'), SHARED(cloud));
      await write(acc(id, 'remote', 'user_keys.vcfg'), KEYS(`bind_${id}`));
      await write(acc(id, 'local', 'cfg', 'user_keys_0_slot0.vcfg'), KEYS(`bind_${id}`));
      await write(acc(id, 'remote', 'user_convars.vcfg'), CONVARS(id));
      await write(acc(id, 'remotecache.vdf'), `cache ${id}`);
    }
    await write(acc('111', 'local', 'cfg', 'user_keys_0_slot0.vcfg_lastclouded'), 'nope');
    await write(acc('111', 'local', 'cfg', 'user_keys_0_slot1.vcfg'), '"config"\n{\n}\n');
    await fs.mkdir(path.join(steam, 'userdata', '0'), { recursive: true });
  });

  const core = () => new Core({ dataDir: data, steamPath: steam, isDotaRunning: async () => dota });

  it('discovers accounts, names and cloud status', async () => {
    const s = await core().listAccounts();
    expect(s.accounts.map((a) => [a.id, a.name, a.cloud, a.cloudSyncState])).toEqual([
      ['111', 'Alpha', 'off-global', null],
      ['222', 'Beta', 'off-dota', null],
      ['333', 'Gamma', 'on', 'conflictingchanges'],
    ]);
    expect(s.lastCheck).toBeNull();
    expect(s.accounts.every((a) => a.firstSeen)).toBe(true);
  });

  it('reports changes since the last check', async () => {
    await core().listAccounts();
    await write(acc('222', 'remote', 'user_keys.vcfg'), KEYS('changed'));
    const s = await core().listAccounts();
    const beta = s.accounts.find((a) => a.id === '222')!;
    expect(beta.firstSeen).toBe(false);
    expect(beta.changes.map((c) => c.category)).toEqual(['hotkeys']);
    expect(beta.changes[0].files[0].changes[0]).toMatchObject({ path: ['bindings', 'SPACE'], before: 'bind_222', after: 'changed' });
    expect(s.accounts.find((a) => a.id === '111')!.changes).toEqual([]);
  });

  it('diffs, pushes with a backup, and restores', async () => {
    const c = core();
    await c.listAccounts();
    const diff = await c.getDiff('111', '222', ['hotkeys']);
    expect(diff[0].changed).toBe(true);
    expect(diff[0].files.map((f) => [f.file, f.status])).toEqual([
      ['local/cfg/user_keys_0_slot0.vcfg', 'changed'],
      ['local/cfg/user_keys_0_slot1.vcfg', 'added'],
      ['remote/user_keys.vcfg', 'changed'],
    ]);

    const r = await c.push('111', ['222'], ['hotkeys', 'convars']);
    expect(r.ok).toBe(true);
    expect(r.results[0].filesWritten).toBe(5);
    expect(await fs.readFile(acc('222', 'remote', 'user_keys.vcfg'), 'utf8')).toBe(KEYS('bind_111'));
    // convars pair: source only has remote/, so local/cfg slot0 is filled from it
    expect(await fs.readFile(acc('222', 'local', 'cfg', 'user_convars_0_slot0.vcfg'), 'utf8')).toBe(CONVARS('111'));
    // never-copied files untouched
    expect(await fs.readFile(acc('222', 'remotecache.vdf'), 'utf8')).toBe('cache 222');
    await expect(fs.access(acc('222', 'local', 'cfg', 'user_keys_0_slot0.vcfg_lastclouded'))).rejects.toThrow();
    // no temp files left
    expect((await fs.readdir(acc('222', 'remote'))).some((f) => f.endsWith('.tmp'))).toBe(false);

    const after = await c.getDiff('111', '222', ['hotkeys', 'convars']);
    expect(after.every((d) => !d.changed)).toBe(true);

    const s = await c.listAccounts();
    expect(s.backups).toHaveLength(1);
    const b = s.backups[0];
    expect(b.created.sort()).toEqual(['local/cfg/user_convars_0_slot0.vcfg', 'local/cfg/user_keys_0_slot1.vcfg']);

    const rr = await c.restore(b.id, '222');
    expect(rr.ok).toBe(true);
    expect(await fs.readFile(acc('222', 'remote', 'user_keys.vcfg'), 'utf8')).toBe(KEYS('bind_222'));
    await expect(fs.access(acc('222', 'local', 'cfg', 'user_keys_0_slot1.vcfg'))).rejects.toThrow();
    expect((await c.listAccounts()).backups.map((x) => x.reason)).toEqual(['restore', 'push']);
  });

  it('blocks pushes while Dota runs', async () => {
    const c = core();
    await c.listAccounts();
    dota = true;
    const r = await c.push('111', ['222'], ['hotkeys']);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Dota 2 is running/);
    expect(await fs.readFile(acc('222', 'remote', 'user_keys.vcfg'), 'utf8')).toBe(KEYS('bind_222'));
  });

  it('blocks pushes to accounts with Steam Cloud on, but allows them as source', async () => {
    const c = core();
    await c.listAccounts();
    const r = await c.push('111', ['222', '333'], ['hotkeys']);
    expect(r.results.find((x) => x.accountId === '222')!.ok).toBe(true);
    expect(r.results.find((x) => x.accountId === '333')).toMatchObject({ ok: false, error: expect.stringMatching(/Steam Cloud/) });
    expect(await fs.readFile(acc('333', 'remote', 'user_keys.vcfg'), 'utf8')).toBe(KEYS('bind_333'));
    const r2 = await c.push('333', ['111'], ['convars']);
    expect(r2.ok).toBe(true);
  });

  it('keeps account-bound convars on the target', async () => {
    const conv = (name: string, speed: string, extra = '') =>
      `"config"\r\n{\r\n\t"convars"\r\n\t{\r\n\t\t"dota_camera_speed"\t\t"${speed}"\r\n\t\t"dota_disable_acknowledged_item_auto_equip"\t\t"true"\r\n${extra}\t\t"name"\t\t"${name}"\r\n\t}\r\n}\r\n`;
    await write(acc('111', 'remote', 'user_convars.vcfg'), conv('Alpha', '3000', '\t\t"dota_turbo_matches_played"\t\t"327"\r\n'));
    await write(acc('222', 'remote', 'user_convars.vcfg'), conv('Beta', '1500'));
    const c = core();
    await c.listAccounts();
    const diff = await c.getDiff('111', '222', ['convars']);
    const remote = diff[0].files.find((f) => f.file === 'remote/user_convars.vcfg')!;
    expect(remote.changes.map((x) => x.path.join('/'))).toEqual(['convars/dota_camera_speed']);
    await c.push('111', ['222'], ['convars']);
    expect(await fs.readFile(acc('222', 'remote', 'user_convars.vcfg'), 'utf8')).toBe(conv('Beta', '3000'));
    // local slot0 is filled from the source's remote copy, also with Beta's name kept
    expect(await fs.readFile(acc('222', 'local', 'cfg', 'user_convars_0_slot0.vcfg'), 'utf8')).toBe(conv('Beta', '3000'));
  });

  it('rejects bad input', async () => {
    const c = core();
    await c.listAccounts();
    await expect(c.push('111', ['999'], ['hotkeys'])).rejects.toThrow(/Unknown account/);
    await expect(c.push('111', ['111'], ['hotkeys'])).rejects.toThrow(/source/);
    await expect(c.push('111', ['222'], ['../x' as never])).rejects.toThrow(/category/);
    await expect(c.restore('../../x', '222')).rejects.toThrow(/backup/);
  });
});
