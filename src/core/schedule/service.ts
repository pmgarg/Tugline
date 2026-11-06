/**
 * `tug schedule install-service`: run `tug daemon` as a per-user service.
 * macOS gets a launchd agent, Linux a systemd user unit. The text is generated
 * here (and tested); the CLI writes the file and prints the one command that
 * loads it, so nothing is started behind the user's back.
 */
import os from 'node:os';
import path from 'node:path';

export interface ServiceSpec {
  /** Absolute path to node. */
  node: string;
  /** Absolute path to the CLI entry (dist/cli/main.js). */
  cli: string;
  /** Extra args for `tug daemon` (e.g. --port 7878). */
  args?: string[];
  homeDir: string;
  /** Environment to pass (e.g. TUG_BASE_URL). Secrets belong in the vault, not here. */
  env?: Record<string, string>;
  label?: string;
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function launchdPlist(s: ServiceSpec): string {
  const label = s.label ?? 'dev.tugline.daemon';
  const argv = [s.node, s.cli, 'daemon', ...(s.args ?? [])];
  const logDir = path.join(s.homeDir, 'schedule');
  const env = { ...(s.env ?? {}) };
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${argv.map((a) => `    <string>${xml(a)}</string>`).join('\n')}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(env).map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`).join('\n')}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>${xml(path.join(logDir, 'daemon.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(path.join(logDir, 'daemon.err.log'))}</string>
</dict>
</plist>
`;
}

/** systemd quoting: wrap in double quotes when needed, escape backslash and quote. */
function sdQuote(a: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `"${a.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function systemdUnit(s: ServiceSpec): string {
  const argv = [s.node, s.cli, 'daemon', ...(s.args ?? [])];
  const env = { ...(s.env ?? {}) };
  return `[Unit]
Description=Tugline scheduler daemon (scheduled tasks and event triggers)
After=network-online.target

[Service]
Type=simple
ExecStart=${argv.map(sdQuote).join(' ')}
${Object.entries(env).map(([k, v]) => `Environment=${sdQuote(`${k}=${v}`)}`).join('\n')}
Restart=on-failure
RestartSec=30
NoNewPrivileges=true

[Install]
WantedBy=default.target
`;
}

export function servicePaths(platform: NodeJS.Platform = process.platform, home = os.homedir()): { kind: 'launchd' | 'systemd'; file: string; load: string; unload: string } {
  if (platform === 'darwin') {
    const file = path.join(home, 'Library', 'LaunchAgents', 'dev.tugline.daemon.plist');
    return { kind: 'launchd', file, load: `launchctl bootstrap gui/$(id -u) ${file}`, unload: `launchctl bootout gui/$(id -u) ${file}` };
  }
  const file = path.join(home, '.config', 'systemd', 'user', 'tugline-daemon.service');
  return { kind: 'systemd', file, load: 'systemctl --user daemon-reload && systemctl --user enable --now tugline-daemon.service', unload: 'systemctl --user disable --now tugline-daemon.service' };
}
