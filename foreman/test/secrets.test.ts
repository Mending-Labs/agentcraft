// The secrets vault (/secret set in game): encrypted at rest, decrypted in memory only, never
// echoed; MCP tokens taken from it (or out of the environment) and kept away from the agents.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { silentLogger } from '../src/context.js';
import { McpCatalog, parseMcp } from '../src/mcp.js';
import { SecretVault } from '../src/secrets.js';
import { makeForeman, rmrf, tempDir } from './helpers.js';

const SEED = { seed: { url: 'https://seed.example/api/mcp', bearerTokenEnvVar: 'AC_TEST_VAULT_TOKEN', lead: 'write', workers: 'read' } };

afterEach(() => {
  delete process.env.AC_TEST_VAULT_TOKEN;
});

describe('MCP tokens', () => {
  it('come from the vault first, else the environment, which loses them', () => {
    process.env.AC_TEST_VAULT_TOKEN = 'from-env';
    const vault = new Map<string, string>();
    const cat = new McpCatalog(parseMcp(SEED), silentLogger, fetch, (n) => vault.get(n));
    expect(process.env.AC_TEST_VAULT_TOKEN).toBeUndefined(); // moved out at once: children cannot inherit it
    expect(cat.forRole('lead')[0]?.[2]).toBe('from-env');
    vault.set('AC_TEST_VAULT_TOKEN', 'from-vault');
    expect(cat.forRole('lead')[0]?.[2]).toBe('from-vault');
  });

  it('are scrubbed from an agent environment', () => {
    const cat = new McpCatalog(parseMcp(SEED), silentLogger);
    const env = cat.scrub({ PATH: 'x', ac_test_vault_token: 'leak', OTHER: 'y' });
    expect(env).toEqual({ PATH: 'x', OTHER: 'y' });
  });
});

describe.runIf(process.platform === 'win32')('the vault (Windows DPAPI)', () => {
  it('stores encrypted, decrypts in a new process, deletes', async () => {
    const home = tempDir();
    try {
      await new SecretVault(home).set('AC_TOKEN', 'p@ss "é" $x');
      const file = fs.readFileSync(path.join(home, 'secrets.json'), 'utf8');
      expect(file).not.toContain('p@ss');
      const again = new SecretVault(home);
      expect(again.get('AC_TOKEN')).toBeUndefined();
      expect(await again.unlock()).toEqual([]);
      expect(again.get('AC_TOKEN')).toBe('p@ss "é" $x');
      expect(await again.delete('AC_TOKEN')).toBe(true);
      expect(again.names()).toEqual([]);
    } finally {
      rmrf(home);
    }
  });

  it('refuses bad names and values', async () => {
    const v = new SecretVault(tempDir());
    await expect(v.set('bad name', 'x')).rejects.toThrow(/name/);
    await expect(v.set('OK', 'a\nb')).rejects.toThrow(/line breaks/);
  });

  it('secret.set: only the name ever comes back (ack, status, feed)', async () => {
    const home = tempDir();
    const h = makeForeman(home, ['--backend', 'claude']);
    try {
      const replies: unknown[] = [];
      await h.fm.handle({ v: 1, type: 'secret.set', id: 'c1', name: 'AC_TOKEN', value: 'TOPSECRET-123' }, (m) => replies.push(m));
      expect(h.fm.status.secrets).toEqual(['AC_TOKEN']);
      expect(h.fm.secrets.get('AC_TOKEN')).toBe('TOPSECRET-123');
      const everything = JSON.stringify([replies, h.events, h.fm.store.data.feed]);
      expect(everything).toContain('AC_TOKEN');
      expect(everything).not.toContain('TOPSECRET');
      await h.fm.handle({ v: 1, type: 'secret.delete', id: 'c2', name: 'AC_TOKEN' }, () => {});
      expect(h.fm.status.secrets).toEqual([]);
    } finally {
      await h.fm.close();
      rmrf(home);
    }
  });
});
