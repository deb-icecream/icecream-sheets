/**
 * Pinned Python environment for PY() (node-only).
 *
 * Import from '@icecream-sheets/service/python-env' — never from the
 * browser bundle (node:child_process / node:crypto / node:fs).
 *
 * What "pinned" means:
 * - The environment is a venv living at
 *   <root>/<sha256(requirements + python version)>/, i.e. content-addressed:
 *   changing the pinned requirements provisions a NEW directory and never
 *   mutates (or shares state with) an existing one.
 * - Runs use the venv's interpreter, which carries exactly the pinned
 *   pandas/numpy/matplotlib versions — not whatever the system python has.
 * - Code runs under the same restricted prelude as the engine's default
 *   PY() provider (PY_PRELUDE + parsePythonEnvelope from
 *   @icecream-sheets/engine), so the sandbox contract — safe builtins,
 *   import allowlist, `result` variable, plot capture — is identical.
 *
 * Honest limits: same as the engine PY() sandbox (safe builtins +
 * allowlist + timeout, not a kernel sandbox). The venv does not add
 * isolation; it adds reproducibility.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  PY_PRELUDE,
  parsePythonEnvelope,
  type PythonResult,
} from '@icecream-sheets/engine';

/** Pinned data-science stack for PY(). Versions support CPython 3.10–3.12. */
export const PINNED_PYTHON_REQUIREMENTS: string[] = [
  'numpy==1.26.4',
  'pandas==2.2.3',
  'matplotlib==3.8.4',
];

/** Bump when the provisioning procedure itself changes (invalidates envs). */
export const PYTHON_ENV_FORMAT_VERSION = 1;

export interface EnvMarker {
  formatVersion: number;
  fingerprint: string;
  requirements: string[];
  pythonVersion: string;
  provisionedAt: string;
}

/** sha256 hex of the canonical environment identity. */
export function pythonEnvFingerprint(requirements: string[], pythonVersion: string): string {
  const h = createHash('sha256');
  h.update(`icecream-pyenv/v${PYTHON_ENV_FORMAT_VERSION}\n`);
  h.update(`python:${pythonVersion}\n`);
  for (const r of [...requirements].sort()) h.update(`req:${r}\n`);
  return h.digest('hex').slice(0, 32);
}

/** Default root: ~/.cache/icecream-sheets/pyenvs (XDG_CACHE_HOME honored). */
export function defaultPythonEnvRoot(): string {
  const base = process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache');
  return join(base, 'icecream-sheets', 'pyenvs');
}

/** `python3 --version` -> '3.12.3'. Throws when python3 is missing. */
export function systemPythonVersion(pythonBin = 'python3'): string {
  const out = String(execFileSync(pythonBin, ['--version'], { encoding: 'utf8' })).trim();
  const m = /(\d+\.\d+\.\d+)/.exec(out);
  if (!m) throw new Error(`could not parse python version from: ${out}`);
  return m[1]!;
}

export interface ProvisionOptions {
  /** Provisioning timeout (venv + pip install). Defaults to 15 minutes. */
  timeoutMs?: number;
  /** Progress messages (venv creation, pip output tail on failure). */
  onProgress?: (message: string) => void;
}

export interface PythonRunOptions {
  /** Wall-clock timeout for the user program. Defaults to 5000ms. */
  timeoutMs?: number;
}

export class PinnedPythonEnv {
  readonly rootDir: string;
  readonly requirements: string[];
  readonly pythonBin: string;

  constructor(
    rootDir: string = defaultPythonEnvRoot(),
    requirements: string[] = PINNED_PYTHON_REQUIREMENTS,
    pythonBin = 'python3',
  ) {
    this.rootDir = rootDir;
    this.requirements = [...requirements];
    this.pythonBin = pythonBin;
  }

  /** Content-addressed identity of this environment. */
  fingerprint(pythonVersion?: string): string {
    return pythonEnvFingerprint(this.requirements, pythonVersion ?? systemPythonVersion(this.pythonBin));
  }

  /** Directory this exact environment lives in (created by provision()). */
  envDir(pythonVersion?: string): string {
    return join(this.rootDir, this.fingerprint(pythonVersion));
  }

  /** Interpreter inside the venv. */
  venvPython(pythonVersion?: string): string {
    return join(this.envDir(pythonVersion), 'bin', 'python');
  }

  private markerPath(pythonVersion?: string): string {
    return join(this.envDir(pythonVersion), '.icecream-pyenv.json');
  }

  /** True when the marker exists and matches this environment's fingerprint. */
  isProvisioned(pythonVersion?: string): boolean {
    try {
      const raw = readFileSync(this.markerPath(pythonVersion), 'utf8');
      const marker = JSON.parse(raw) as EnvMarker;
      return (
        marker.formatVersion === PYTHON_ENV_FORMAT_VERSION &&
        marker.fingerprint === this.fingerprint(pythonVersion)
      );
    } catch {
      return false;
    }
  }

  /** Read the provision marker (null when not provisioned). */
  marker(pythonVersion?: string): EnvMarker | null {
    try {
      return JSON.parse(readFileSync(this.markerPath(pythonVersion), 'utf8')) as EnvMarker;
    } catch {
      return null;
    }
  }

  /**
   * Provision the environment: `python3 -m venv`, then pip-install the
   * pinned requirements. Idempotent — a provisioned env is left alone.
   * Throws with the failing step and its output on failure.
   */
  provision(opts: ProvisionOptions = {}): EnvMarker {
    const timeoutMs = opts.timeoutMs ?? 15 * 60 * 1000;
    const say = opts.onProgress ?? ((): void => undefined);
    const pyVersion = systemPythonVersion(this.pythonBin);
    const dir = this.envDir(pyVersion);
    if (this.isProvisioned(pyVersion)) {
      say(`Python env already provisioned at ${dir}`);
      return this.marker(pyVersion)!;
    }
    mkdirSync(this.rootDir, { recursive: true });
    say(`Creating venv at ${dir} ...`);
    try {
      execFileSync(this.pythonBin, ['-m', 'venv', dir], { timeout: 120_000, stdio: 'pipe' });
    } catch (e) {
      throw new Error(`python venv creation failed: ${stepMessage(e)}`);
    }
    const pip = join(dir, 'bin', 'pip');
    if (this.requirements.length > 0) {
      say(`Installing ${this.requirements.join(', ')} ...`);
      try {
        execFileSync(pip, ['install', '--quiet', ...this.requirements], {
          timeout: timeoutMs,
          stdio: 'pipe',
          maxBuffer: 64 * 1024 * 1024,
        });
      } catch (e) {
        throw new Error(`pip install failed for [${this.requirements.join(', ')}]: ${stepMessage(e)}`);
      }
    }
    const marker: EnvMarker = {
      formatVersion: PYTHON_ENV_FORMAT_VERSION,
      fingerprint: this.fingerprint(pyVersion),
      requirements: [...this.requirements],
      pythonVersion: pyVersion,
      provisionedAt: new Date().toISOString(),
    };
    writeFileSync(this.markerPath(pyVersion), JSON.stringify(marker, null, 2));
    say(`Python env provisioned at ${dir}`);
    return marker;
  }

  /**
   * Run Python code in the provisioned venv under the shared restricted
   * prelude. Throws when the env is not provisioned (call provision()
   * first — never silently fall back to the system interpreter, which
   * would break the "pinned" guarantee).
   */
  run(code: string, args: unknown[], opts: PythonRunOptions = {}): PythonResult {
    const pyVersion = systemPythonVersion(this.pythonBin);
    if (!this.isProvisioned(pyVersion)) {
      return {
        error:
          `pinned Python env is not provisioned at ${this.envDir(pyVersion)}. ` +
          'Call provision() first.',
      };
    }
    let argsJson: string;
    try {
      argsJson = JSON.stringify(args ?? []);
    } catch {
      return { error: 'PY arguments are not JSON-serializable.' };
    }
    let stdout: string;
    try {
      const out = execFileSync(this.venvPython(pyVersion), ['-c', PY_PRELUDE, argsJson], {
        input: code,
        encoding: 'utf8',
        timeout: opts.timeoutMs ?? 5000,
        maxBuffer: 16 * 1024 * 1024,
      });
      stdout = String(out ?? '');
    } catch (e) {
      return { error: `PY execution failed: ${stepMessage(e)}` };
    }
    return parsePythonEnvelope(stdout);
  }

  /** pip freeze of the venv (for diagnostics). Empty when not provisioned. */
  installedPackages(pythonVersion?: string): string[] {
    try {
      const out = execFileSync(join(this.envDir(pythonVersion), 'bin', 'pip'), ['freeze'], {
        encoding: 'utf8',
        timeout: 30_000,
      });
      return String(out).split('\n').map((l) => l.trim()).filter(Boolean);
    } catch {
      return [];
    }
  }
}

function stepMessage(e: unknown): string {
  if (e instanceof Error) {
    const withOutput = e as Error & { stdout?: unknown; stderr?: unknown };
    const tail = (v: unknown): string => {
      const s = String(v ?? '').trim().split('\n');
      return s.slice(-5).join('\n');
    };
    const extra = [tail(withOutput.stdout), tail(withOutput.stderr)].filter(Boolean).join('\n');
    return extra ? `${e.message}\n${extra}` : e.message;
  }
  return String(e);
}
