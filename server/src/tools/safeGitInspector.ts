import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const MAX_OUTPUT_BYTES = 128 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

const DIFF_EXCLUDES = [
  ':(exclude)**/.git/**',
  ':(exclude)**/node_modules/**',
  ':(exclude)**/.env',
  ':(exclude)**/.env.*',
  ':(exclude)**/.npmrc',
  ':(exclude)**/*.pem',
  ':(exclude)**/*.key',
  ':(exclude)**/id_rsa',
  ':(exclude)**/id_ed25519',
] as const;

export interface SafeGitInspectionResult {
  command: string;
  cwd: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  outputTruncated: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
}

function isSensitivePath(input: string): boolean {
  const normalized = input.replace(/^"|"$/g, '').replaceAll('\\\\', '/');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.some((part) => part === '.git' || part === 'node_modules')) {
    return true;
  }

  const base = parts.at(-1)?.toLowerCase() ?? '';
  return (
    base === '.env' ||
    base.startsWith('.env.') ||
    base === '.npmrc' ||
    base === 'id_rsa' ||
    base === 'id_ed25519' ||
    base.endsWith('.pem') ||
    base.endsWith('.key')
  );
}

function sanitizeStatus(stdout: string): string {
  return stdout
    .split(/\r?\n/)
    .filter((line) => {
      if (!line) return false;
      const payload = line.length > 3 ? line.slice(3) : line;
      const paths = payload.split(' -> ').map((value) => value.trim());
      return !paths.some(isSensitivePath);
    })
    .join('\n');
}

export class SafeGitInspector {
  private readonly root: string;

  constructor(workspaceRoot: string) {
    if (!workspaceRoot) throw new Error('Workspace root is required.');
    this.root = fs.realpathSync(path.resolve(workspaceRoot));
  }

  status(): Promise<SafeGitInspectionResult> {
    return this.runGit(['status', '--short', '--untracked-files=all'], true);
  }

  diff(): Promise<SafeGitInspectionResult> {
    return this.runGit(
      ['diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--', '.', ...DIFF_EXCLUDES],
      false,
    );
  }

  private async runGit(
    args: readonly string[],
    filterStatus: boolean,
  ): Promise<SafeGitInspectionResult> {
    const startedAt = Date.now();

    return await new Promise<SafeGitInspectionResult>((resolve, reject) => {
      const child = spawn('git', [...args], {
        cwd: this.root,
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
          return;
        }

        const slice = chunk.subarray(0, remaining);
        outputBytes += slice.length;
        if (target === 'stdout') stdout += slice.toString('utf8');
        else stderr += slice.toString('utf8');

        if (slice.length < chunk.length) {
          outputTruncated = true;
        }
      };

      child.stdout.on('data', (chunk: Buffer) => append('stdout', chunk));
      child.stderr.on('data', (chunk: Buffer) => append('stderr', chunk));

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, DEFAULT_TIMEOUT_MS);

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
          command: ['git', ...args].join(' '),
          cwd: '.',
          exitCode,
          signal,
          timedOut,
          outputTruncated,
          durationMs: Date.now() - startedAt,
          stdout: filterStatus ? sanitizeStatus(stdout) : stdout,
          stderr,
        });
      });
    });
  }
}
