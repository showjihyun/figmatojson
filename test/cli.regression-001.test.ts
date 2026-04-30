/**
 * Regression: BUG-001 — 사용자에게 fatal 에러가 stack trace를 노출하면 안 됨
 * Found by /qa on 2026-04-30
 * Report: .gstack/qa-reports/qa-report-figma-reverse-2026-04-30.md
 *
 * 시나리오: 알 수 없는 magic byte를 가진 파일을 던졌을 때 stderr 출력은
 *   - "error: " 프리픽스로 시작
 *   - 사용자 친화적 메시지 포함 (file path, magic bytes)
 *   - "at <function>" 같은 stack frame 라인 미포함
 *   - 단 DEBUG=1 환경변수 시에는 stack 포함됨
 */
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'figrev-reg-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function runCli(args: string[], env: NodeJS.ProcessEnv = {}): { stdout: string; stderr: string; code: number } {
  try {
    const stdout = execSync(`npx tsx src/cli.ts ${args.map((a) => `"${a}"`).join(' ')}`, {
      env: { ...process.env, ...env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '', code: 0 };
  } catch (e) {
    const err = e as { stdout?: Buffer | string; stderr?: Buffer | string; status?: number };
    return {
      stdout: err.stdout?.toString() ?? '',
      stderr: err.stderr?.toString() ?? '',
      code: err.status ?? 1,
    };
  }
}

describe('BUG-001 regression: fatal errors hide stack trace from users', () => {
  it('garbage file: stderr has clean error message, no stack frames', () => {
    const garbagePath = join(tmp, 'garbage.fig');
    writeFileSync(garbagePath, 'this is not a fig file');

    const { stderr, code } = runCli(['extract', garbagePath, join(tmp, 'out')]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/^error: /);
    expect(stderr).toContain('Unknown file magic');
    // stack frame 라인이 없어야: "    at functionName (path:line:col)"
    expect(stderr).not.toMatch(/^\s+at\s+\w+\s*\(/m);
  });

  it('truncated ZIP: stderr has clean error, no stack frames', () => {
    const truncPath = join(tmp, 'truncated.fig');
    // ZIP magic + truncated rest
    writeFileSync(truncPath, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0, 0, 0]));

    const { stderr, code } = runCli(['extract', truncPath, join(tmp, 'out')]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/^error: /);
    expect(stderr).not.toMatch(/^\s+at\s+\w+\s*\(/m);
  });

  it('DEBUG=1 env var: stack trace IS exposed (for debugging)', () => {
    const garbagePath = join(tmp, 'garbage.fig');
    writeFileSync(garbagePath, 'not a fig');

    const { stderr, code } = runCli(['extract', garbagePath, join(tmp, 'out')], { DEBUG: '1' });
    expect(code).toBe(1);
    expect(stderr).toMatch(/^error: /);
    // DEBUG 모드에서는 stack frame 노출
    expect(stderr).toMatch(/at\s+\w+/);
  });

  it('--verbose flag: stack trace IS exposed', () => {
    const garbagePath = join(tmp, 'garbage.fig');
    writeFileSync(garbagePath, 'not a fig');

    const { stderr, code } = runCli(['extract', garbagePath, join(tmp, 'out'), '--verbose']);
    expect(code).toBe(1);
    expect(stderr).toMatch(/at\s+\w+/);
  });
});
