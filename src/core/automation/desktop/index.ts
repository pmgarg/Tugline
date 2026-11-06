/** WS6 desktop computer use (SPEC F1–F10): side-effect imports register the tools, the loop extension and the commands. */
export * from './config.js';
export * from './backend.js';
export * from './driver.js';
export * from './traps.js';
export * from './killswitch.js';
export * from './selfprotect.js';
export { CuaDriverBackend, versionMatches } from './cua.js';
export { SidecarBackend, NdjsonParser, SIDECAR_METHODS } from './sidecar.js';
export { DesktopSession, getDesktopSession, closeDesktopSession, closeAllDesktopSessions } from './session.js';
export { replayDesktop } from './replay.js';
import './tools.js';
import './commands.js';
