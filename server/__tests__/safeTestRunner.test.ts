import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SafeTestRunner } from '../src/tools/safeTestRunner.js';

describe('SafeTestRunner', () => {
  let root: string;
  let runner: SafeTestRunner;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-agents-test-runner-'));
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({
        name: 'safe-test-fixture',
        private: true,
        scripts: {
          test: "node -e \"console.log('SAFE_TEST_OK')\"",
          start: "node -e \"console.log('SHOULD_NOT_RUN')\"",
        },
      }),
    );
    runner = new SafeTestRunner(root);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('runs an allowed npm test command in the workspace', async () => {
    const result = await runner.run('npm', ['test']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('SAFE_TEST_OK');
    expect(result.timedOut).toBe(false);
  });

  it('rejects non-test npm scripts', async () => {
    await expect(runner.run('npm', ['run', 'start'])).rejects.toThrow(
      'not allowed in the Tester runtime',
    );
  });

  it('rejects shell-like argument injection', async () => {
    await expect(runner.run('npm', ['test', '--', '&&'])).rejects.toThrow(
      'Unsafe test argument rejected',
    );
  });

  it('rejects cwd traversal outside the workspace', async () => {
    await expect(runner.run('npm', ['test'], '..')).rejects.toThrow(
      'Test cwd escapes the workspace',
    );
  });
});
