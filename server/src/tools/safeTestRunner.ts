import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 180_000;
const MAX_OUTPUT_BYTES = 128 * 1024;

const SAFE_SCRIPT_NAME =
  /^(?:test(?::[A-Za-z0-9_.-]+)?|lint(?::[A-Za-z0-9_.-]+)?|typecheck|check-types|build(?::[A-Za-z0-9_.-]+)?|compile)$/;
const SAFE_ARG = /^[A-Za-z0-9_./\\:@=,+-]+$/;

export interface SafeTestRunResult {
  command: string;
  cwd: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  outputTruncated: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
}

function minimalChildEnv(): NodeJS.ProcessEnv {
  const keep = [
    'PATH',
    'Path',
    'PATHEXT',
    'SystemRoot',
    'ComSpec',
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'TEMP',
    'TMP',
    'TMPDIR',
  ] as const;

  const env: NodeJS.ProcessEnv = {
    CI: '1',
    NODE_ENV: 'test',
  };

  for (const key of keep) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }

  return env;
}

export class SafeTestRunner {
  private readonly root: string;

  constructor(workspaceRoot: string) {
    if (!workspaceRoot) throw new Error('Workspace root is required.');
    this.root = fs.realpathSync(path.resolve(workspaceRoot));
  }

  async run(
    command: string,
    args: readonly string[],
    cwd = '.',
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<SafeTestRunResult> {
    const safeCwd = this.resolveCwd(cwd);
    this.validateCommand(command, args);

    const effectiveTimeout = Math.min(Math.max(timeoutMs, 1_000), MAX_TIMEOUT_MS);
    const executable = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const startedAt = Date.now();

    return await new Promise<SafeTestRunResult>((resolve, reject) => {
      const child = spawn(executable, [...args], {
        cwd: safeCwd,
        env: minimalChildEnv(),
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let outputBytes = 0;
      let outputTruncated = false;
      let timedOut = false;
      let settled = false;

      const append = (target: 'stdout' | 'stderr', chunk: Buffer): void => {
        if (outputTruncated) return;

        const remaining = MAX_OUTPUT_BYTES - outputBytes;
        if (remaining <= 0) {
          outputTruncated = true;
          child.kill();
          return;
        }

        const slice = chunk.subarray(0, remaining);
        outputBytes += slice.length;
        if (target === 'stdout') stdout += slice.toString('utf8');
        else stderr += slice.toString('utf8');

        if (slice.length < chunk.length) {
          outputTruncated = true;
          child.kill();
        }
      };

      child.stdout.on('data', (chunk: Buffer) => append('stdout', chunk));
      child.stderr.on('data', (chunk: Buffer) => append('stderr', chunk));

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, effectiveTimeout);

      child.on('error', (err) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        reject(err);
      });

      child.on('close', (exitCode, signal) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;

        resolve({
          command: [command, ...args].join(' '),
          cwd: path.relative(this.root, safeCwd) || '.',
          exitCode,
          signal,
          timedOut,
          outputTruncated,
          durationMs: Date.now() - startedAt,
          stdout,
          stderr,
        });
      });
    });
  }

  private validateCommand(command: string, args: readonly string[]): void {
    if (command !== 'npm') {
      throw new Error('Only npm test/build quality commands are allowed in the Tester runtime.');
    }

    if (args.length === 0) {
      throw new Error('npm command arguments are required.');
    }

    if (args[0] === 'test') {
      this.validateExtraArgs(args.slice(1));
      return;
    }

    if (args[0] === 'run') {
      const script = args[1];
      if (!script || !SAFE_SCRIPT_NAME.test(script)) {
        throw new Error('This npm script is not allowed in the Tester runtime.');
      }
      this.validateExtraArgs(args.slice(2));
      return;
    }

    throw new Error('Only npm test or approved npm run scripts are allowed.');
  }

  private validateExtraArgs(args: readonly string[]): void {
    for (const arg of args) {
      if (arg === '--') continue;
      if (!SAFE_ARG.test(arg)) {
        throw new Error(`Unsafe test argument rejected: ${arg}`);
      }
    }
  }

  private resolveCwd(input: string): string {
    if (path.isAbsolute(input)) {
      throw new Error('Absolute cwd paths are not allowed.');
    }

    const candidate = path.resolve(this.root, input || '.');
    const relative = path.relative(this.root, candidate);
    if (
      relative === '..' ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new Error('Test cwd escapes the workspace.');
    }

    const realCandidate = fs.realpathSync(candidate);
    const realRelative = path.relative(this.root, realCandidate);
    if (
      realRelative === '..' ||
      realRelative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(realRelative)
    ) {
      throw new Error('Resolved test cwd escapes the workspace.');
    }

    if (!fs.statSync(realCandidate).isDirectory()) {
      throw new Error('Test cwd must be a directory.');
    }

    return realCandidate;
  }
}
