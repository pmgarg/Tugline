/**
 * Voice input (v1.1 N25), the parts without `vscode`: where audio goes, whether
 * that is local, how it is recorded, and the transcription request.
 *
 * - Local first: the transcriber is an OpenAI-compatible
 *   `/v1/audio/transcriptions` endpoint (whisper.cpp server, faster-whisper,
 *   vLLM), set as a profile (`tugline.voice.transcriber`, its key is used)
 *   or a URL (`tugline.voice.url`, no key is sent: the chat's API key never
 *   goes to a URL typed for voice). A transcriber that is not on loopback or
 *   the LAN gets a warning before the first recording.
 * - Audio is recorded by sox, ffmpeg or arecord to stdout, kept in memory,
 *   sent once and dropped. It is never written to disk.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';

export type RecorderKind = 'sox' | 'ffmpeg' | 'arecord';

export interface TranscriberTarget {
  url: string;
  apiKey?: string;
  headers?: Record<string, string>;
}

/** The transcription URL for a profile base URL (…/v1 → …/v1/audio/transcriptions). */
export function transcriptionUrl(baseUrl: string): string {
  const b = baseUrl.replace(/\/+$/, '');
  return /\/audio\/transcriptions$/.test(b) ? b : `${b}/audio/transcriptions`;
}

function ipv4Local(a: string): boolean {
  const p = a.split('.').map(Number);
  return p[0] === 127 || p[0] === 10 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) || (p[0] === 100 && p[1] >= 64 && p[1] <= 127);
}

/**
 * Whether audio sent to this URL stays on this machine or the local network:
 * loopback, RFC 1918 / CGNAT IPv4, IPv6 loopback, ULA and link-local,
 * `localhost`, `*.localhost` and mDNS `*.local` names. Any other name is
 * treated as remote (it may resolve anywhere).
 */
export function isLocalEndpoint(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  const h = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  if (net.isIPv4(h)) return ipv4Local(h);
  if (net.isIPv6(h)) {
    if (h === '::1') return true;
    const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
    if (m) return ipv4Local(m[1]);
    return /^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h);
  }
  return false;
}

/** argv that records 16 kHz mono WAV to stdout for at most `maxSeconds`. */
export function recorderArgv(kind: RecorderKind, platform: NodeJS.Platform, maxSeconds: number): string[] {
  const secs = String(Math.max(1, Math.round(maxSeconds)));
  if (kind === 'sox') return ['sox', '-q', '-d', '-t', 'wav', '-r', '16000', '-c', '1', '-b', '16', '-', 'trim', '0', secs];
  if (kind === 'arecord') return ['arecord', '-q', '-f', 'S16_LE', '-r', '16000', '-c', '1', '-t', 'wav', '-d', secs, '-'];
  const input = platform === 'darwin' ? ['-f', 'avfoundation', '-i', ':0'] : platform === 'win32' ? ['-f', 'dshow', '-i', 'audio=default'] : ['-f', 'pulse', '-i', 'default'];
  return ['ffmpeg', '-hide_banner', '-loglevel', 'error', ...input, '-ac', '1', '-ar', '16000', '-t', secs, '-f', 'wav', '-'];
}

/** The recorder to use: the configured one, or the first installed of sox, ffmpeg, arecord (Linux only). */
export function pickRecorder(want: 'auto' | RecorderKind, installed: (bin: string) => boolean, platform: NodeJS.Platform): RecorderKind | undefined {
  if (want !== 'auto') return installed(want) ? want : undefined;
  const order: RecorderKind[] = platform === 'linux' ? ['sox', 'ffmpeg', 'arecord'] : ['sox', 'ffmpeg'];
  return order.find((k) => installed(k));
}

/** A recording in progress: stdout is collected in memory; stop() ends it and returns the audio. */
export class Recording {
  private chunks: Buffer[] = [];
  private bytes = 0;
  private done: Promise<Buffer>;
  private child: ChildProcess;
  error = '';

  constructor(argv: string[], private maxBytes = 25 * 1024 * 1024) {
    this.child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
    this.child.stdout!.on('data', (d: Buffer) => {
      if (this.bytes + d.length > this.maxBytes) return;
      this.chunks.push(d);
      this.bytes += d.length;
    });
    this.child.stderr!.on('data', (d: Buffer) => (this.error = (this.error + d.toString()).slice(-2000)));
    this.done = new Promise((resolve) => {
      this.child.on('error', (e) => {
        this.error = e.message;
        resolve(Buffer.alloc(0));
      });
      this.child.on('close', () => resolve(Buffer.concat(this.chunks)));
    });
  }

  /** bytes captured so far */
  get size(): number {
    return this.bytes;
  }

  get running(): boolean {
    // A recorder that failed to start (ENOENT) has no pid: never signal it. Signalling a child with no pid can
    // reach the whole process group (pid 0) and interrupt the parent, which is what kept stopping `npm test`.
    return this.child.pid !== undefined && this.child.exitCode === null && this.child.signalCode === null;
  }

  /** Ends the recording (SIGINT lets the recorder flush) and returns the audio; nothing is kept. */
  async stop(): Promise<Buffer> {
    if (this.running) this.child.kill('SIGINT');
    const kill = setTimeout(() => {
      if (this.running) this.child.kill('SIGKILL');
    }, 3000);
    const audio = await this.done;
    clearTimeout(kill);
    this.chunks = [];
    return audio;
  }

  /** Resolves when the recorder ends by itself (max length reached). */
  ended(): Promise<Buffer> {
    return this.done;
  }
}

export type VoiceFetch = (url: string, init: { method: string; headers: Record<string, string>; body: FormData; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** POST the audio as multipart (file, model, language, response_format=json) and return the text. */
export async function transcribe(fetchFn: VoiceFetch, t: TranscriberTarget, audio: Buffer, o: { model: string; language?: string; timeoutMs?: number; filename?: string }): Promise<string> {
  if (!audio.length) throw new Error('no audio was recorded');
  const fd = new FormData();
  fd.append('file', new Blob([new Uint8Array(audio)], { type: 'audio/wav' }), o.filename ?? 'speech.wav');
  fd.append('model', o.model);
  fd.append('response_format', 'json');
  if (o.language) fd.append('language', o.language);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), o.timeoutMs ?? 60_000);
  try {
    const res = await fetchFn(t.url, { method: 'POST', headers: { ...(t.apiKey ? { Authorization: `Bearer ${t.apiKey}` } : {}), ...(t.headers ?? {}) }, body: fd, signal: ctl.signal });
    const body = await res.text();
    if (!res.ok) throw new Error(`transcriber answered ${res.status}: ${body.slice(0, 300)}`);
    let text: string;
    try {
      const j = JSON.parse(body);
      text = typeof j.text === 'string' ? j.text : '';
    } catch {
      text = body; // response_format ignored: plain text
    }
    return text.replace(/\s+/g, ' ').trim();
  } finally {
    clearTimeout(timer);
  }
}
