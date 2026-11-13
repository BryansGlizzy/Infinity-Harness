import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HarnessManager, updateDotEnvFile } from '../src/harnesses.ts';
import { setup } from './harness.ts';

test('updateDotEnvFile preserves comments and updates or appends keys', async () => {
  const s = await setup();
  try {
    const envFile = join(s.cfg.root, '.env');
    writeFileSync(envFile, '# comment\nKEV_MODEL=kev-9b\nNVIDIA_MODEL=old-model\n');
    updateDotEnvFile(envFile, { NVIDIA_MODEL: 'deepseek-ai/deepseek-v3.2', LOCAL_LLM_BASE_URL: 'http://127.0.0.1:8000/v1' });
    const text = readFileSync(envFile, 'utf8');
    assert.match(text, /# comment/);
    assert.match(text, /KEV_MODEL=kev-9b/);
    assert.match(text, /NVIDIA_MODEL=deepseek-ai\/deepseek-v3.2/);
    assert.match(text, /LOCAL_LLM_BASE_URL=http:\/\/127\.0\.0\.1:8000\/v1/);
  } finally {
    await s.close();
  }
});

test('HarnessManager lists all 6 system harnesses, runs install, and dynamically links configured pools', async () => {
  const s = await setup();
  try {
    const binDir = join(s.cfg.root, 'fake-bin');
    mkdirSync(binDir, { recursive: true });
    const env: NodeJS.ProcessEnv = { PATH: binDir };

    let installed = false;
    const mgr = new HarnessManager({
      config: s.cfg,
      env,
      runInstallCommand: async () => {
        // Simulate installing claude into binDir
        const claudeBin = join(binDir, 'claude');
        writeFileSync(
          claudeBin,
          '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.0"; exit 0; fi\nif [ "$1" = "auth" ] && [ "$2" = "status" ]; then echo \'{"loggedIn":true,"email":"dev@example.com","subscriptionType":"pro"}\'; exit 0; fi\n',
        );
        chmodSync(claudeBin, 0o755);
        installed = true;
        return { ok: true, output: 'installed claude 2.1.0' };
      },
    });

    const initial = await mgr.list();
    assert.equal(initial.length, 6);
    assert.deepEqual(
      initial.map((h) => h.id),
      ['claude', 'codex', 'kimi', 'agy', 'opencode', 'gh'],
    );
    const claudeBefore = initial.find((h) => h.id === 'claude')!;
    assert.equal(claudeBefore.installed, false);

    // Install claude and verify it becomes installed + signed_in + adds 'claude' to pools
    const res = await mgr.install('claude');
    assert.equal(res.ok, true);
    assert.equal(installed, true);
    assert.equal(res.harness.installed, true);
    assert.equal(res.harness.auth.status, 'signed_in');
    assert.equal(res.harness.auth.account, 'dev@example.com');
    assert.ok(res.pools.some((p) => p.id === 'claude'));

    // Configure NIM and Local LLM via configureEnv and verify both pools appear
    const envRes = await mgr.configureEnv({
      nimApiKey: 'nvapi-test-key',
      nimModel: 'deepseek-ai/deepseek-v3.2',
      localBaseUrl: 'http://127.0.0.1:8000/v1',
      localModel: 'qwen3-coder',
    });
    assert.equal(envRes.harness.auth.status, 'configured');
    assert.equal(envRes.harness.envConfig?.nimApiKeySet, true);
    assert.ok(envRes.pools.some((p) => p.id === 'nim'));
    assert.ok(envRes.pools.some((p) => p.id === 'local'));
  } finally {
    await s.close();
  }
});
