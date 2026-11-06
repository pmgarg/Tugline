/**
 * Push-to-talk voice input (v1.1 N25), VS Code part. Off by default
 * (`tugline.voice.enabled`). "Tugline: Voice Input" (Ctrl+Alt+V, or
 * the 🎤 button in the composer) starts recording; pressing it again stops,
 * the audio goes to the transcriber, and the text is inserted in the composer
 * for the user to edit and send. Nothing is sent to the model by itself.
 *
 * The audio is captured by a local recorder program (voice.ts) rather than
 * the webview: VS Code webviews have no microphone permission.
 */
import * as vscode from 'vscode';
import fs from 'node:fs';
import path from 'node:path';
import type { ChatViewProvider } from './chat.js';
import { clientProfile } from './settingsConfig.js';
import { isLocalEndpoint, pickRecorder, recorderArgv, Recording, transcribe, transcriptionUrl, type TranscriberTarget, type VoiceFetch } from './voice.js';

function onPath(bin: string): boolean {
  const exts = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  return (process.env.PATH ?? '').split(path.delimiter).some((d) => d && exts.some((e) => fs.existsSync(path.join(d, bin + e.toLowerCase())) || fs.existsSync(path.join(d, bin + e))));
}

export class VoiceController implements vscode.Disposable {
  private rec?: Recording;
  private status: vscode.StatusBarItem;
  private confirmedRemote = new Set<string>();
  /** tests and the log */
  lastTranscript?: string;
  lastError?: string;
  lastWarning?: string;
  lastTarget?: string;

  constructor(private provider: ChatViewProvider, private log: (m: string) => void, private fetchFn: VoiceFetch = (u, i) => fetch(u, i as any) as any) {
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49);
    this.status.command = 'tugline.voice.toggle';
  }

  dispose(): void {
    void this.rec?.stop();
    this.status.dispose();
  }

  get recording(): boolean {
    return !!this.rec;
  }

  private settings() {
    return vscode.workspace.getConfiguration('tugline');
  }

  /** Where the audio goes: voice.url (no key), else the voice.transcriber profile (its key), from the governed config. */
  private async target(): Promise<TranscriberTarget | undefined> {
    const s = this.settings();
    const url = s.get<string>('voice.url');
    if (url) return { url };
    const profile = s.get<string>('voice.transcriber');
    if (!profile) return undefined;
    const cfg = this.provider.lastConfig ?? (await this.provider.buildConfig(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd()));
    if (!cfg.profiles[profile]) throw new Error(`no profile "${profile}" (tugline.voice.transcriber)`);
    const p = clientProfile(cfg, profile);
    return { url: transcriptionUrl(p.baseUrl), apiKey: p.apiKey, headers: p.headers };
  }

  private fail(m: string): undefined {
    this.lastError = m;
    this.log(`[voice] ${m}`);
    void vscode.window.showErrorMessage(`Tugline voice: ${m}`);
    return undefined;
  }

  /**
   * Start or stop push-to-talk. `audioFile` transcribes a file instead of the
   * microphone (tests, a recorded note); `confirmRemote` answers the
   * non-local warning without asking.
   */
  async toggle(o: { audioFile?: string; confirmRemote?: boolean } = {}): Promise<string | undefined> {
    if (!this.settings().get<boolean>('voice.enabled', false)) {
      void vscode.window.showInformationMessage('Tugline: voice input is off. Turn on tugline.voice.enabled and set tugline.voice.transcriber (a profile) or tugline.voice.url (e.g. a whisper.cpp server).');
      return undefined;
    }
    if (this.rec) return this.finish(await this.stopRecording());
    let t: TranscriberTarget | undefined;
    try {
      t = await this.target();
    } catch (e) {
      return this.fail((e as Error).message);
    }
    if (!t) return this.fail('no transcriber: set tugline.voice.transcriber (a profile) or tugline.voice.url.');
    this.lastTarget = t.url;
    if (!isLocalEndpoint(t.url) && !this.confirmedRemote.has(t.url)) {
      const host = new URL(t.url).host;
      this.lastWarning = `Voice audio would go to ${host}, which is not on this machine or your local network.`;
      const ok = o.confirmRemote ?? (await vscode.window.showWarningMessage(`Tugline: ${this.lastWarning} Send recordings there?`, { modal: true }, 'Send anyway')) === 'Send anyway';
      if (!ok) return undefined;
      this.confirmedRemote.add(t.url);
    }
    if (o.audioFile) return this.finish(fs.readFileSync(o.audioFile), t);
    const s = this.settings();
    const kind = pickRecorder(s.get('voice.recorder', 'auto'), onPath, process.platform);
    if (!kind) return this.fail('no audio recorder found: install sox (recommended), ffmpeg or arecord, or set tugline.voice.recorder.');
    this.rec = new Recording(recorderArgv(kind, process.platform, s.get<number>('voice.maxSeconds', 60)));
    this.pendingTarget = t;
    this.status.text = '$(record) Recording… click or Ctrl+Alt+V to stop';
    this.status.show();
    void vscode.commands.executeCommand('setContext', 'tugline.voiceRecording', true);
    const rec = this.rec;
    void rec.ended().then(async () => {
      // the recorder stopped by itself (max length, or it failed)
      if (this.rec === rec) await this.finish(await this.stopRecording());
    });
    return undefined;
  }

  private pendingTarget?: TranscriberTarget;

  private async stopRecording(): Promise<Buffer> {
    const rec = this.rec!;
    this.rec = undefined;
    this.status.hide();
    void vscode.commands.executeCommand('setContext', 'tugline.voiceRecording', false);
    const audio = await rec.stop();
    if (!audio.length && rec.error) this.lastError = rec.error;
    return audio;
  }

  private async finish(audio: Buffer, target = this.pendingTarget): Promise<string | undefined> {
    this.pendingTarget = undefined;
    if (!target) return undefined;
    const s = this.settings();
    try {
      const text = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Tugline: transcribing…' }, () => transcribe(this.fetchFn, target, audio, { model: s.get<string>('voice.model', 'whisper-1'), language: s.get<string>('voice.language') || undefined }));
      this.lastTranscript = text;
      this.lastError = undefined;
      if (text) this.provider.insertInComposer(text);
      else void vscode.window.showInformationMessage('Tugline: no speech recognised.');
      return text;
    } catch (e) {
      const cause = (e as any)?.cause;
      return this.fail(`${(e as Error).message}${cause ? ` (${cause.code ?? ''} ${cause.message ?? cause})` : ''}`);
    }
  }
}
