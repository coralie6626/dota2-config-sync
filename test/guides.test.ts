import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Core } from '../src/main/core';
import {
  d2ptGuideHero,
  generateGuides,
  toolError,
  type GeneratedGuides,
  type PythonCmd,
} from '../src/main/guides';
import type { GuideProgress } from '../src/shared/types';

const guide = (hero: string, title: string) =>
  `"guidedata"\n{\n\t"Hero"\t\t"${hero}"\n\t"Title"\t\t"${title}"\n\t"GuideFormatVersion"\t\t"2"\n}\n`;
const SHARED_OFF = `"UserRoamingConfigStore"\n{\n\t"Software"\n\t{\n\t\t"Valve"\n\t\t{\n\t\t\t"Steam"\n\t\t\t{\n\t\t\t\t"CloudEnabled"\t\t"0"\n\t\t\t}\n\t\t}\n\t}\n}\n`;

async function write(file: string, text: string) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
}

/** Stands in for `python -m d2pt_guides`: node runs this script, which ignores "-m d2pt_guides". */
const FAKE_TOOL = String.raw`
const fs = require('fs'), path = require('path');
const args = process.argv.slice(2);
const out = args[args.indexOf('--out') + 1];
const mode = process.env.FAKE_MODE;
if (mode === 'blocked') { console.error('error: dota2protracker.com returned 403 (Cloudflare)'); process.exit(1); }
if (mode === 'hang') { console.log('[1/2] Sven'); setInterval(() => {}, 1000); return; }
const heroes = [['sven', 'Sven'], ['naga_siren', 'Naga Siren']];
heroes.forEach(([h, name], i) => {
  console.log('[' + (i + 1) + '/2] ' + name);
  const f = path.join(out, h + '_16000' + i + '101.build');
  fs.writeFileSync(f, '"guidedata"\n{\n\t"Hero"\t\t"' + h + '"\n\t"Title"\t\t"D2PT ' + name + '"\n}\n');
  console.log('wrote ' + f);
});
fs.writeFileSync(path.join(out, 'notes.txt'), 'ignored');
`;

describe('d2pt-guides runner', () => {
  let py: PythonCmd;
  beforeEach(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'd2cs-fake-'));
    const script = path.join(dir, 'fake.cjs');
    await fs.writeFile(script, FAKE_TOOL);
    py = { command: process.execPath, args: [script] };
    delete process.env.FAKE_MODE;
  });

  it('reads the generated guides and reports progress', async () => {
    const seen: GuideProgress[] = [];
    const g = await generateGuides(py, { onProgress: (p) => seen.push(p) });
    expect([...g.files.keys()].sort()).toEqual([
      'naga_siren_160001101.build',
      'sven_160000101.build',
    ]);
    expect([...g.heroes].sort()).toEqual(['naga_siren', 'sven']);
    expect(seen.at(-1)).toMatchObject({
      done: 2,
      total: 2,
      label: 'Naga Siren',
      generated: 2,
    });
  });

  it("surfaces the tool's error line", async () => {
    process.env.FAKE_MODE = 'blocked';
    await expect(generateGuides(py)).rejects.toThrow(
      /d2pt-guides: dota2protracker.com returned 403/,
    );
    delete process.env.FAKE_MODE;
  });

  it('can be cancelled', async () => {
    process.env.FAKE_MODE = 'hang';
    const ctrl = new AbortController();
    const p = generateGuides(py, {
      signal: ctrl.signal,
      onProgress: () => ctrl.abort(),
    });
    await expect(p).rejects.toThrow(/Cancelled/);
    delete process.env.FAKE_MODE;
  });

  it('parses errors and D2PT guide headers', () => {
    expect(toolError('Traceback\nboom\n', 2)).toBe(
      'd2pt-guides failed (exit code 2): Traceback boom',
    );
    expect(d2ptGuideHero(guide('sven', 'D2PT Sven Carry'))).toBe('sven');
    expect(d2ptGuideHero(guide('sven', 'My Sven'))).toBeNull();
  });
});

describe('Core.installGuides', () => {
  let steam: string;
  let data: string;
  let dota = false;
  const gdir = (id: string) =>
    path.join(steam, 'userdata', id, '570', 'remote', 'guides');

  beforeEach(async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'd2cs-g-'));
    steam = path.join(tmp, 'Steam');
    data = path.join(tmp, 'data');
    dota = false;
    for (const id of ['111', '222']) {
      await write(
        path.join(steam, 'userdata', id, '7', 'remote', 'sharedconfig.vdf'),
        SHARED_OFF,
      );
      await fs.mkdir(path.join(steam, 'userdata', id, '570'), {
        recursive: true,
      });
    }
    await fs.mkdir(path.join(steam, 'userdata', '333', '570'), {
      recursive: true,
    }); // Steam Cloud on
    await write(
      path.join(gdir('111'), 'sven_1500000000.build'),
      guide('sven', 'D2PT Sven Old'),
    );
    await write(
      path.join(gdir('111'), 'sven_1400000000.build'),
      guide('sven', 'My own Sven'),
    );
    await write(
      path.join(gdir('111'), 'axe_1500000000.build'),
      guide('axe', 'D2PT Axe'),
    );
  });

  const core = () =>
    new Core({
      dataDir: data,
      steamPath: steam,
      isDotaRunning: async () => dota,
    });
  const guides = (): GeneratedGuides => ({
    files: new Map([
      ['sven_1600039101.build', Buffer.from(guide('sven', 'D2PT Sven Carry'))],
    ]),
    heroes: new Set(['sven']),
  });

  it('installs, replaces only older D2PT guides of the same heroes, and restores', async () => {
    const c = core();
    const r = await c.installGuides(['111', '222', '333'], guides(), true);
    expect(r.results.find((x) => x.accountId === '111')).toMatchObject({
      ok: true,
      filesWritten: 1,
      filesRemoved: 1,
    });
    expect(r.results.find((x) => x.accountId === '222')).toMatchObject({
      ok: true,
      filesWritten: 1,
      filesRemoved: 0,
    });
    expect(r.results.find((x) => x.accountId === '333')).toMatchObject({
      ok: false,
      error: expect.stringMatching(/Steam Cloud/),
    });
    expect((await fs.readdir(gdir('111'))).sort()).toEqual([
      'axe_1500000000.build',
      'sven_1400000000.build',
      'sven_1600039101.build',
    ]);
    expect(await fs.readdir(gdir('222'))).toEqual(['sven_1600039101.build']);

    const b = (await c.listAccounts()).backups.find(
      (x) => x.accountId === '111',
    )!;
    expect(b.reason).toBe('import');
    expect((await c.restore(b.id, '111')).ok).toBe(true);
    expect((await fs.readdir(gdir('111'))).sort()).toEqual([
      'axe_1500000000.build',
      'sven_1400000000.build',
      'sven_1500000000.build',
    ]);
  });

  it('keeps older guides without replace', async () => {
    await core().installGuides(['111'], guides(), false);
    expect(await fs.readdir(gdir('111'))).toHaveLength(4);
  });

  it('blocks while Dota runs and rejects bad input', async () => {
    const c = core();
    dota = true;
    expect(await c.checkGuideTargets(['111'])).toMatch(/Dota 2 is running/);
    expect((await c.installGuides(['111'], guides(), true)).error).toMatch(
      /Dota 2 is running/,
    );
    dota = false;
    expect(await c.checkGuideTargets(['333'])).toMatch(/Steam Cloud/);
    expect(await c.checkGuideTargets(['111'])).toBeNull();
    await expect(c.installGuides(['999'], guides(), true)).rejects.toThrow(
      /Unknown account/,
    );
    const bad: GeneratedGuides = {
      files: new Map([['../x.build', Buffer.from('')]]),
      heroes: new Set(),
    };
    await expect(c.installGuides(['111'], bad, true)).rejects.toThrow(
      /Bad guide file name/,
    );
  });
});
