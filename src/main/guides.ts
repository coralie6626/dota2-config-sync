// Runs the d2pt-guides Python tool (github.com/Darktex/d2pt-guides) to generate hero guides
// from Dota2ProTracker, then hands the .build files to Core to install into accounts.
// The tool isn't bundled: the user installs Python and `pip install`s it.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import type { GuideProgress, GuideToolStatus } from '../shared/types';

export interface PythonCmd {
  command: string;
  args: string[];
}

export interface GeneratedGuides {
  /** File name (e.g. "sven_1600039100.build") -> contents. */
  files: Map<string, Buffer>;
  /** Internal hero names the guides are for (e.g. "sven"). */
  heroes: Set<string>;
}

/** Names the tool gives its files: <hero>_<stable id>.build. */
export const GUIDE_FILE_RE = /^[a-z0-9_]+_\d+\.build$/;
const HERO_RE = /^\s*"Hero"\s+"([a-z0-9_]+)"/m;
export const INSTALL_HINT =
  'pip install git+https://github.com/Darktex/d2pt-guides';

const CANDIDATES: PythonCmd[] =
  process.platform === 'win32'
    ? [
        { command: 'py', args: ['-3'] },
        { command: 'python', args: [] },
      ]
    : [
        { command: 'python3', args: [] },
        { command: 'python', args: [] },
      ];

const PROBE = [
  'import sys',
  'print(sys.version.split()[0])',
  'try:',
  '    import d2pt_guides',
  '    print(getattr(d2pt_guides, "__version__", "?"))',
  'except ImportError:',
  '    print("")',
].join('\n');

const pythonEnv = () => ({
  ...process.env,
  PYTHONUNBUFFERED: '1',
  PYTHONUTF8: '1',
  PYTHONIOENCODING: 'utf-8',
});

function probe(
  py: PythonCmd,
): Promise<{ python: string; tool: string } | null> {
  return new Promise((resolve) => {
    execFile(
      py.command,
      [...py.args, '-c', PROBE],
      {
        windowsHide: true,
        timeout: 15_000,
        env: pythonEnv(),
        cwd: os.tmpdir(),
      },
      (err, stdout) => {
        const [python = '', tool = ''] = String(stdout).trim().split(/\r?\n/);
        resolve(
          err || !/^\d+\.\d+/.test(python)
            ? null
            : { python, tool: tool.trim() },
        );
      },
    );
  });
}

function versionAtLeast(v: string, major: number, minor: number): boolean {
  const [a, b] = v.split('.').map(Number);
  return a > major || (a === major && b >= minor);
}

export class GuideTool {
  private cmd: PythonCmd | null = null;

  constructor(private readonly candidates: PythonCmd[] = CANDIDATES) {}

  /** Find a Python 3.10+ with d2pt_guides installed. Re-checks every call so installing it while the app runs works. */
  async status(): Promise<GuideToolStatus> {
    this.cmd = null;
    let python: string | null = null;
    for (const c of this.candidates) {
      const r = await probe(c);
      if (!r) continue;
      if (!versionAtLeast(r.python, 3, 10)) {
        python ??= r.python;
        continue;
      }
      python = r.python;
      if (r.tool) {
        this.cmd = c;
        return {
          ok: true,
          python: r.python,
          toolVersion: r.tool,
          installHint: INSTALL_HINT,
        };
      }
    }
    const error = !python
      ? 'Python was not found. Install Python 3.10 or newer from python.org, then install d2pt-guides.'
      : !versionAtLeast(python, 3, 10)
        ? `Python ${python} is too old. d2pt-guides needs Python 3.10 or newer.`
        : 'd2pt-guides is not installed for this Python.';
    return {
      ok: false,
      python,
      toolVersion: null,
      installHint: INSTALL_HINT,
      error,
    };
  }

  async command(): Promise<PythonCmd> {
    if (!this.cmd) {
      const s = await this.status();
      if (!s.ok) throw new Error(s.error);
    }
    return this.cmd!;
  }
}

/**
 * Run `python -m d2pt_guides --all-heroes` into a fresh temp folder and read back the guides.
 * Takes ~8 minutes for every hero (one request per hero and position, ~1 s apart); cached for 30 minutes.
 */
export async function generateGuides(
  py: PythonCmd,
  opts: { signal?: AbortSignal; onProgress?: (p: GuideProgress) => void } = {},
): Promise<GeneratedGuides> {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'd2cs-guides-'));
  try {
    await runTool(py, outDir, opts);
    return await readGuides(outDir);
  } finally {
    await fs.rm(outDir, { recursive: true, force: true });
  }
}

function runTool(
  py: PythonCmd,
  outDir: string,
  {
    signal,
    onProgress,
  }: { signal?: AbortSignal; onProgress?: (p: GuideProgress) => void },
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Cancelled'));
    const child = spawn(
      py.command,
      [...py.args, '-m', 'd2pt_guides', '--all-heroes', '--out', outDir],
      {
        // An empty folder as cwd, so `-m` can't pick up a stray d2pt_guides package from elsewhere.
        cwd: outDir,
        env: pythonEnv(),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stderr = '';
    let pending = '';
    let generated = 0;
    let last: GuideProgress = {
      phase: 'generating',
      done: 0,
      total: 0,
      label: 'Starting…',
      generated: 0,
    };

    const onAbort = () => child.kill();
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) {
        const m = /^\[(\d+)\/(\d+)\]\s+(.*)$/.exec(line);
        if (m)
          last = {
            ...last,
            done: Number(m[1]),
            total: Number(m[2]),
            label: m[3].trim(),
          };
        else if (line.startsWith('wrote '))
          last = { ...last, generated: ++generated };
        else continue;
        onProgress?.(last);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-8000);
    });

    child.on('error', (e) => {
      signal?.removeEventListener('abort', onAbort);
      reject(e);
    });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(new Error('Cancelled'));
      if (code === 0) return resolve();
      reject(new Error(toolError(stderr, code)));
    });
  });
}

/** The tool's own "error: ..." line, or the end of what it printed. */
export function toolError(stderr: string, code: number | null): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const err = [...lines].reverse().find((l) => l.startsWith('error:'));
  if (err) return `d2pt-guides: ${err.slice(6).trim()}`;
  const tail = lines.slice(-3).join(' ');
  return `d2pt-guides failed (exit code ${code ?? '?'})${tail ? `: ${tail}` : ''}`;
}

async function readGuides(dir: string): Promise<GeneratedGuides> {
  const files = new Map<string, Buffer>();
  const heroes = new Set<string>();
  for (const name of await fs.readdir(dir)) {
    if (!GUIDE_FILE_RE.test(name)) continue;
    const buf = await fs.readFile(path.join(dir, name));
    const hero = HERO_RE.exec(buf.subarray(0, 500).toString('utf8'))?.[1];
    if (!hero) continue;
    files.set(name, buf);
    heroes.add(hero);
  }
  if (files.size === 0)
    throw new Error('d2pt-guides finished but wrote no guides.');
  return { files, heroes };
}

/** True for a guide file this tool made (vs. one the player wrote or got from the workshop). */
export function d2ptGuideHero(head: string): string | null {
  if (!/^\s*"Title"\s+"D2PT /m.test(head)) return null;
  return HERO_RE.exec(head)?.[1] ?? null;
}
