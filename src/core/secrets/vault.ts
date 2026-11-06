/**
 * Secrets vault (SPEC E8; reused by channels, H3).
 *
 * The model refers to a credential only as `secret://name` (Playwright MCP's
 * `--secrets` has the same idea). The harness resolves the value at the last
 * moment, inside the driver, and never returns it: tool args, journals and
 * trajectories keep the ref, and every value that was used is registered for
 * redaction so a page that echoes it back cannot leak it either.
 *
 * Backends, first hit wins:
 *  1. environment `TUG_SECRET_<NAME>` (CI and exported Playwright specs);
 *  2. the OS keychain via `keytar`, if that optional package is installed;
 *  3. `<homeDir>/secrets.json`, a flat {name: value} map written with mode 0600.
 *     A file readable by group/others is refused, like ssh does for keys.
 */
import fs from 'node:fs';
import path from 'node:path';

export const SECRET_REF = /^secret:\/\/([A-Za-z0-9_.\-/]{1,128})$/;
const KEYTAR_SERVICE = 'tugline';

export function parseSecretRef(ref: string): string | undefined {
  return ref.trim().match(SECRET_REF)?.[1];
}

export function envNameFor(name: string): string {
  return `TUG_SECRET_${name.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`;
}

export class SecretError extends Error {}

export class SecretVault {
  readonly file: string;
  /** Every value handed out by this vault, for redaction. */
  private used = new Set<string>();
  private keytar: any | null | undefined;

  constructor(homeDir: string, private env: NodeJS.ProcessEnv = process.env) {
    this.file = path.join(homeDir, 'secrets.json');
  }

  private readFile(): Record<string, string> {
    if (!fs.existsSync(this.file)) return {};
    if (process.platform !== 'win32') {
      const mode = fs.statSync(this.file).mode & 0o777;
      if (mode & 0o077) throw new SecretError(`${this.file} is readable by other users (mode ${mode.toString(8)}); run: chmod 600 ${this.file}`);
    }
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
    } catch {
      throw new SecretError(`${this.file} is not valid JSON`);
    }
  }

  private async loadKeytar(): Promise<any | null> {
    if (this.keytar !== undefined) return this.keytar;
    try {
      const mod = 'keytar';
      const k: any = await import(mod);
      this.keytar = k.default ?? k;
    } catch {
      this.keytar = null;
    }
    return this.keytar;
  }

  /** Resolve a `secret://name` ref (or a bare name). Throws SecretError if unknown. */
  async resolve(refOrName: string): Promise<string> {
    const name = parseSecretRef(refOrName) ?? (SECRET_REF.test(`secret://${refOrName}`) ? refOrName : undefined);
    if (!name) throw new SecretError(`invalid secret ref "${refOrName}"; expected secret://name`);
    let value: string | undefined = this.env[envNameFor(name)];
    if (value === undefined) {
      const kt = await this.loadKeytar();
      if (kt) value = (await kt.getPassword(KEYTAR_SERVICE, name).catch(() => null)) ?? undefined;
    }
    if (value === undefined) {
      const v = this.readFile()[name];
      if (typeof v === 'string') value = v;
    }
    if (value === undefined) throw new SecretError(`secret "${name}" is not set. Ask the user to add it (tug secrets set ${name}, or ${envNameFor(name)}=…); never ask them to paste it into the chat.`);
    this.used.add(value);
    return value;
  }

  /** Names only; values never leave the vault through this API. */
  list(): string[] {
    const names = new Set(Object.keys(this.readFile()));
    for (const k of Object.keys(this.env)) if (k.startsWith('TUG_SECRET_')) names.add(k.slice(10).toLowerCase());
    return [...names].sort();
  }

  /** Store a value in the file backend (mode 0600). */
  set(name: string, value: string): void {
    if (!SECRET_REF.test(`secret://${name}`)) throw new SecretError(`invalid secret name "${name}"`);
    const cur = this.readFile();
    cur[name] = value;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cur, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    fs.chmodSync(this.file, 0o600);
  }

  /** Values resolved so far (for redaction of anything a page echoes back). */
  usedValues(): string[] {
    return [...this.used];
  }

  /** Replace every used secret value in `s` with •••. */
  redact(s: string): string {
    let out = s;
    for (const v of this.used) if (v.length >= 4) out = out.split(v).join('•••');
    return out;
  }
}
