// The secrets vault: tokens the user types in game (/secret set NAME, a masked field) for the team's
// MCP servers, so they never sit in a file, in the config or in an environment variable the agents
// inherit.
//
//   Windows  DPAPI (CurrentUser): the encrypted blob is kept in <home>/secrets.json; only this
//            Windows account on this machine can decrypt it (ConvertFrom-SecureString)
//   macOS    the login keychain (security add-generic-password, service "agentcraft")
//   Linux    the Secret Service (secret-tool, attributes service=agentcraft name=<NAME>) on a
//            desktop; on a server (no Secret Service, or AGENTCRAFT_VAULT=file) AES-256-GCM with a
//            key file (<home>/vault.key, owner-only, or AGENTCRAFT_VAULT_KEY_FILE): it protects the
//            secrets from copies of secrets.json and from other accounts, not from the account the
//            Foreman runs as
//
// Values go to the helper processes on stdin, never on a command line. Decrypted values live only
// in the Foreman's memory (unlock() at start); they are never logged, never sent back to a client
// (foreman.status lists the names only) and never put in an agent's environment.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { run } from './util/proc.js';
import { writeJsonAtomic } from './util/fsx.js';

export class SecretError extends Error {}

type Entry = { backend: 'dpapi'; blob: string } | { backend: 'keychain' } | { backend: 'secret-service' } | { backend: 'file'; iv: string; tag: string; data: string };

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const PS = ['-NoProfile', '-NonInteractive', '-Command'];
// PowerShell 5.1: SecureString <-> DPAPI blob (CurrentUser scope), the secret on stdin
const UTF8 = '[Console]::InputEncoding = [Text.Encoding]::UTF8; [Console]::OutputEncoding = [Text.Encoding]::UTF8; ';
const PS_PROTECT = UTF8 + '$v = [Console]::In.ReadToEnd(); ConvertTo-SecureString -String $v -AsPlainText -Force | ConvertFrom-SecureString';
const PS_UNPROTECT =
  UTF8 +
  '$s = ConvertTo-SecureString -String ([Console]::In.ReadToEnd().Trim()); $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s); try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($b)) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }';

export class SecretVault {
  private readonly file: string;
  private readonly keyFile: string;
  private values = new Map<string, string>();

  constructor(home: string, private platform: NodeJS.Platform = process.platform) {
    this.file = path.join(home, 'secrets.json');
    this.keyFile = process.env.AGENTCRAFT_VAULT_KEY_FILE?.trim() || path.join(home, 'vault.key');
  }

  /** Linux servers: the key file backend (no Secret Service there). */
  private get useFile(): boolean {
    const v = process.env.AGENTCRAFT_VAULT?.trim().toLowerCase();
    if (v) return v === 'file';
    return this.platform === 'linux' && !process.env.DBUS_SESSION_BUS_ADDRESS;
  }

  /** The 256-bit key, created (owner-only) on first use. */
  private key(): Buffer {
    try {
      const k = Buffer.from(fs.readFileSync(this.keyFile, 'utf8').trim(), 'base64');
      if (k.length === 32) return k;
      throw new SecretError(`${this.keyFile} is not a 256-bit key`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    const k = crypto.randomBytes(32);
    fs.mkdirSync(path.dirname(this.keyFile), { recursive: true });
    fs.writeFileSync(this.keyFile, k.toString('base64'), { mode: 0o600, flag: 'wx' });
    return k;
  }

  private index(): Record<string, Entry> {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8')) as Record<string, Entry>;
    } catch {
      return {};
    }
  }

  /** Names of the stored secrets (never their values); members' AI subscriptions (ACCOUNT_*) are not listed. */
  names(): string[] {
    return Object.keys(this.index())
      .filter((n) => !n.toUpperCase().startsWith('ACCOUNT_'))
      .sort();
  }

  /** A decrypted value (after unlock() or set()). */
  get(name: string): string | undefined {
    return this.values.get(name);
  }

  /** Decrypt every stored secret into memory (errors are reported per name, not thrown). */
  async unlock(): Promise<string[]> {
    const failed: string[] = [];
    for (const [name, e] of Object.entries(this.index())) {
      try {
        this.values.set(name, await this.read(name, e));
      } catch {
        failed.push(name);
      }
    }
    return failed;
  }

  async set(name: string, value: string): Promise<void> {
    if (!NAME.test(name)) throw new SecretError(`bad secret name "${name}" (letters, digits and _, e.g. SEED_MCP_TOKEN)`);
    if (!value || value.length > 8192 || /[\r\n]/.test(value)) throw new SecretError('the secret is empty, too long or has line breaks');
    const entry = await this.write(name, value);
    const index = this.index();
    index[name] = entry;
    this.save(index);
    this.values.set(name, value);
  }

  async delete(name: string): Promise<boolean> {
    const index = this.index();
    const e = index[name];
    if (!e) return false;
    if (e.backend === 'keychain') await run('security', ['delete-generic-password', '-s', 'agentcraft', '-a', name], { timeoutMs: 15_000 });
    if (e.backend === 'secret-service') await run('secret-tool', ['clear', 'service', 'agentcraft', 'name', name], { timeoutMs: 15_000 });
    // (file entries live in secrets.json only)
    delete index[name];
    this.save(index);
    this.values.delete(name);
    return true;
  }

  private save(index: Record<string, Entry>): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    writeJsonAtomic(this.file, index);
    if (this.platform !== 'win32') fs.chmodSync(this.file, 0o600);
  }

  private async write(name: string, value: string): Promise<Entry> {
    if (this.useFile) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', this.key(), iv);
      c.setAAD(Buffer.from(name, 'utf8'));
      const data = Buffer.concat([c.update(value, 'utf8'), c.final()]);
      return { backend: 'file', iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
    }
    if (this.platform === 'win32') {
      const r = await run('powershell.exe', [...PS, PS_PROTECT], { input: value, timeoutMs: 30_000 });
      const blob = r.stdout.trim();
      if (r.code !== 0 || !/^[0-9a-f]+$/i.test(blob)) throw new SecretError(`Windows could not encrypt the secret (DPAPI): ${r.stderr.trim().slice(0, 200)}`);
      return { backend: 'dpapi', blob };
    }
    if (this.platform === 'darwin') {
      // -w as the last option reads the password from stdin (twice: password + retype)
      const r = await run('security', ['add-generic-password', '-U', '-s', 'agentcraft', '-a', name, '-w'], { input: `${value}\n${value}\n`, timeoutMs: 30_000 });
      if (r.code !== 0) throw new SecretError(`the keychain refused the secret: ${r.stderr.trim().slice(0, 200)}`);
      return { backend: 'keychain' };
    }
    const r = await run('secret-tool', ['store', '--label', `AgentCraft ${name}`, 'service', 'agentcraft', 'name', name], { input: value, timeoutMs: 30_000 });
    if (r.code !== 0) throw new SecretError(`no Secret Service to store it in (install libsecret's secret-tool): ${r.stderr.trim().slice(0, 200)}`);
    return { backend: 'secret-service' };
  }

  private async read(name: string, e: Entry): Promise<string> {
    if (e.backend === 'file') {
      const d = crypto.createDecipheriv('aes-256-gcm', this.key(), Buffer.from(e.iv, 'base64'));
      d.setAAD(Buffer.from(name, 'utf8'));
      d.setAuthTag(Buffer.from(e.tag, 'base64'));
      return Buffer.concat([d.update(Buffer.from(e.data, 'base64')), d.final()]).toString('utf8');
    }
    if (e.backend === 'dpapi') {
      const r = await run('powershell.exe', [...PS, PS_UNPROTECT], { input: e.blob, timeoutMs: 30_000 });
      if (r.code !== 0) throw new SecretError(`DPAPI could not decrypt ${name}`);
      return r.stdout;
    }
    if (e.backend === 'keychain') {
      const r = await run('security', ['find-generic-password', '-s', 'agentcraft', '-a', name, '-w'], { timeoutMs: 15_000 });
      if (r.code !== 0) throw new SecretError(`${name} is not in the keychain`);
      return r.stdout.replace(/\n$/, '');
    }
    const r = await run('secret-tool', ['lookup', 'service', 'agentcraft', 'name', name], { timeoutMs: 15_000 });
    if (r.code !== 0) throw new SecretError(`${name} is not in the Secret Service`);
    return r.stdout.replace(/\n$/, '');
  }
}
