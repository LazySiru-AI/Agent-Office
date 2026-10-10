import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { killTree, resolveTaskkillPath, sanitiseInheritedEnv, spawnClaude } from './childProcess.js';

/**
 * These tests spawn real processes, using `node` itself as a stand-in for the
 * CLI. Mocking `child_process` here would test the mock: the behaviour under
 * test *is* the operating system's, and the Windows-specific tree kill is
 * precisely the part that a mock would assert into existence without proving.
 */

const NODE = process.execPath;

describe('spawnClaude', () => {
  it('delivers stdin and closes it, so a reader terminates', async () => {
    // Echoes stdin back. If stdin were never closed this would hang and the
    // test would time out — which is the actual assertion.
    const { exit, child } = spawnClaude({
      binary: NODE,
      args: ['-e', 'process.stdin.resume();let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{process.stdout.write(b);process.exit(0)})'],
      cwd: process.cwd(),
      stdin: 'the brief',
    });

    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c: string) => {
      out += c;
    });

    const result = await exit;
    expect(result.code).toBe(0);
    expect(out).toBe('the brief');
  });

  it('captures stderr for error reporting', async () => {
    const { exit, stderr } = spawnClaude({
      binary: NODE,
      args: ['-e', 'process.stderr.write("boom");process.exit(3)'],
      cwd: process.cwd(),
      stdin: '',
    });

    const result = await exit;
    expect(result.code).toBe(3);
    await expect(stderr).resolves.toContain('boom');
  });

  it('rejects `exit` when the binary does not exist', async () => {
    const { exit } = spawnClaude({
      binary: 'definitely-not-a-real-binary-xyz',
      args: [],
      cwd: process.cwd(),
      stdin: '',
    });

    await expect(exit).rejects.toThrow();
  });

  it('lets an explicit `options.env` override the default sanitising, unchanged', async () => {
    // AO-2: `options.env` is the seam tests use to build an exact fixture
    // environment; the fix for the default path must not start filtering it
    // too, or a caller that deliberately hands in a credential-shaped name
    // (a test asserting something about an API key, say) would silently lose
    // it. Using a name shaped exactly like the denylist pattern proves this
    // path is genuinely unfiltered rather than merely absent from the
    // denylist's own fixture below.
    const { exit, child } = spawnClaude({
      binary: NODE,
      args: ['-e', 'process.stdout.write(process.env.FAKE_API_KEY ?? "")'],
      cwd: process.cwd(),
      stdin: '',
      env: { ...process.env, FAKE_API_KEY: 'should-survive-because-explicit' },
    });

    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c: string) => {
      out += c;
    });

    await exit;
    expect(out).toBe('should-survive-because-explicit');
  });
});

describe('sanitiseInheritedEnv', () => {
  it('strips credential-shaped names so no key reaches a spawned agent process', () => {
    // This is the regression test AO-2 explicitly asked for: assert directly
    // against the sanitising function with a fixture standing in for a real
    // `.env`-merged `process.env`, covering the vendor keys named in the
    // finding plus a few other common credential shapes. Asserting here
    // rather than through a spawned child means a failure points straight at
    // which name leaked, instead of "some process's environment was wrong".
    const fixture: NodeJS.ProcessEnv = {
      ANTHROPIC_API_KEY: 'sk-ant-should-not-survive',
      OPENAI_API_KEY: 'sk-should-not-survive',
      DEEPSEEK_API_KEY: 'sk-should-not-survive',
      GH_TOKEN: 'ghp_should-not-survive',
      NPM_TOKEN: 'should-not-survive',
      AWS_SECRET_ACCESS_KEY: 'should-not-survive',
      DB_PASSWORD: 'should-not-survive',
      SERVICE_ACCOUNT_CREDENTIALS: 'should-not-survive',
      AGENT_OFFICE_CLAUDE_BIN: 'C:\\fake\\claude.exe',
    };

    expect(sanitiseInheritedEnv(fixture)).toEqual({});
  });

  it('strips the S5 additions: DSN/PAT/AUTH segments, AWS_ACCESS_KEY_ID, SSH_AUTH_SOCK, and NPM_CONFIG_ auth fields', () => {
    // Regression test for S5: the original eight segments missed these
    // entirely. Each key here is a distinct gap named in that finding, not a
    // restatement of the same case — see the doc comment on
    // `DENIED_ENV_SEGMENTS` for why each needed its own rule shape.
    const fixture: NodeJS.ProcessEnv = {
      SENTRY_DSN: 'https://public@o0.ingest.sentry.io/0',
      GH_PAT: 'ghp_should-not-survive',
      PROXY_AUTH: 'Basic should-not-survive',
      AWS_ACCESS_KEY_ID: 'AKIAshouldnotsurvive',
      SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
      NPM_CONFIG__AUTHTOKEN: 'should-not-survive',
      NPM_CONFIG__AUTH: 'should-not-survive',
    };

    expect(sanitiseInheritedEnv(fixture)).toEqual({});
  });

  it('does not deny the whole NPM_CONFIG_ namespace — only the auth-shaped keys within it', () => {
    // The failure mode this guards against is the same one the module comment
    // warns about generally: denying `NPM_CONFIG_*` wholesale would be an
    // over-wide filter that could break an in-CLI npm call reading its own
    // ordinary configuration, not just keep out a credential.
    const fixture: NodeJS.ProcessEnv = {
      NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org/',
      NPM_CONFIG_CACHE: 'C:\\Users\\someone\\AppData\\npm-cache',
      NPM_CONFIG_LOGLEVEL: 'warn',
    };

    expect(sanitiseInheritedEnv(fixture)).toEqual(fixture);
  });

  it('denies a variable whose VALUE embeds scheme://user:pass@host, regardless of its name', () => {
    // S5's value-shaped rule: `DATABASE_URL` is the canonical example, but the
    // point of a value check is that the name is irrelevant, so an
    // unrelated-looking name is used here to prove the name isn't what
    // triggered the denial.
    const fixture: NodeJS.ProcessEnv = {
      DATABASE_URL: 'postgres://appuser:hunter2@db.internal:5432/app',
      SOME_INTERNAL_SETTING: 'redis://:hunter2@cache.internal:6379',
    };

    expect(sanitiseInheritedEnv(fixture)).toEqual({});
  });

  it('does not deny a URL-shaped value with no embedded credential', () => {
    // The counterpart to the previous test: a bare host, or a `user@host`
    // with no password, must survive — otherwise the value check would be as
    // over-wide a filter as denying every `*_URL` name outright would have
    // been.
    const fixture: NodeJS.ProcessEnv = {
      DOCS_URL: 'https://docs.example.com/guide',
      HEALTHCHECK_URL: 'https://status.example.com',
      GIT_REMOTE: 'git@github.com:example/repo.git',
    };

    expect(sanitiseInheritedEnv(fixture)).toEqual(fixture);
  });

  it('denies HTTP_PROXY/HTTPS_PROXY too when they embed credentials, even though bare proxy settings survive', () => {
    // Documents the accepted tradeoff from the doc comment on
    // `looksLikeCredentialedUrl`: the "proxy settings survive" guarantee is
    // about the variable being let through when it carries no credential, not
    // a blanket exemption for whichever name a credential happens to be
    // attached to.
    const fixture: NodeJS.ProcessEnv = {
      HTTP_PROXY: 'http://user:hunter2@proxy.example:8080',
    };

    expect(sanitiseInheritedEnv(fixture)).toEqual({});
  });

  it('keeps the variables a real CLI needs to run', () => {
    // The failure this prevents is the opposite one: a denylist broad enough
    // to also catch something ordinary — matching a substring of "PATH" or
    // "HOME" rather than a whole underscore-delimited segment, say — would
    // make every real run fail to find node, git or its temp directory. That
    // breaks louder than a leaked key, but is just as much a regression, and
    // is the one this adapter would hit on literally every run rather than
    // only when something goes looking for a credential.
    const fixture: NodeJS.ProcessEnv = {
      PATH: 'C:\\Windows;C:\\Windows\\System32',
      USERPROFILE: 'C:\\Users\\someone',
      HOME: '/home/someone',
      APPDATA: 'C:\\Users\\someone\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\someone\\AppData\\Local',
      TEMP: 'C:\\Users\\someone\\AppData\\Local\\Temp',
      TMP: 'C:\\Users\\someone\\AppData\\Local\\Temp',
      SystemRoot: 'C:\\Windows',
      ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      LANG: 'en_US.UTF-8',
      HTTP_PROXY: 'http://proxy.example:8080',
      HTTPS_PROXY: 'http://proxy.example:8080',
      NO_PROXY: 'localhost',
    };

    expect(sanitiseInheritedEnv(fixture)).toEqual(fixture);
  });
});

describe('killTree', () => {
  it('terminates a process that would otherwise run forever', async () => {
    const { child, exit } = spawnClaude({
      binary: NODE,
      // Holds an open handle and ignores SIGTERM-by-default behaviour on POSIX
      // only insofar as the timer keeps the loop alive; the point is that it
      // never exits on its own.
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: process.cwd(),
      stdin: '',
    });

    killTree(child);

    const result = await exit;
    // Windows reports a code (taskkill /F), POSIX reports a signal. Asserting
    // either specifically would make this test platform-locked; that it ended
    // at all is the guarantee FR-M9 actually needs.
    expect(result.code !== null || result.signal !== null).toBe(true);
  });

  it('is safe to call twice, and after the process has already exited', async () => {
    const { child, exit } = spawnClaude({
      binary: NODE,
      args: ['-e', 'process.exit(0)'],
      cwd: process.cwd(),
      stdin: '',
    });

    await exit;

    // A cancelled run can race a naturally-finishing one. Killing a corpse must
    // not throw, or cancel would fail exactly when it collided with completion.
    expect(() => killTree(child)).not.toThrow();
    expect(() => killTree(child)).not.toThrow();
  });

  it('resolves taskkill to an absolute path under System32, not a bare name', () => {
    // SEC-06: the defect was `spawn('taskkill', ...)` — a bare name Windows
    // resolves against the *run's own workspace* before PATH or the system
    // directories, so a planted `taskkill.exe` there would run with this
    // server's privileges on the next cancel. Spying on `spawn`'s call args
    // would only prove this function gets called, not what it resolves to;
    // asserting the resolved path directly is what actually rules the
    // cwd-relative lookup back out.
    const resolved = resolveTaskkillPath();

    expect(path.isAbsolute(resolved)).toBe(true);
    expect(resolved.toLowerCase()).toContain(`${path.sep}system32${path.sep}`.toLowerCase());
    expect(resolved.toLowerCase().endsWith('taskkill.exe')).toBe(true);
    expect(resolved).not.toBe('taskkill');
  });
});
