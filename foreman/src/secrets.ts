// The secrets vault: tokens the user types in game (/secret set NAME, a masked field) for the team's
// MCP servers, so they never sit in a file, in the config or in an environment variable the agents
// inherit.
//
//   Windows  DPAPI (CurrentUser): the encrypted blob is kept in <home>/secrets.json; only this
//            Windows account on this machine can decrypt it (ConvertFrom-SecureString)
//   macOS    the login keychain (security add-generic-password, service "agentcraft")
//   Linux    the Secret Service (secret-tool, attributes service=agentcraft name=<NAME>)
//
// Values go to the helper processes on stdin, never on a command line. Decrypted values live only
// in the Foreman's memory (unlock() at start); they are never logged, never sent back to a client
// (foreman.status lists the names only) and never put in an agent's environment.
import fs from 'node:fs';
import path from 'node:path';
import { run } from './util/proc.js';
import { writeJsonAtomic } from './util/fsx.js';

export class SecretError extends Error {}

type Entry = { backend: 'dpapi'; blob: string } | { backend: 'keychain' } | { backend: 'secret-service' };

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
  private values = new Map<string, string>();

  constructor(home: string, private platform: NodeJS.Platform = process.platform) {
    this.file = path.join(home, 'secrets.json');
  }

  private index(): Record<string, Entry> {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8')) as Record<string, Entry>;
    } catch {
      return {};
    }
  }

  /** Names of the stored secrets (never their values). */
  names(): string[] {
    return Object.keys(this.index()).sort();
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
