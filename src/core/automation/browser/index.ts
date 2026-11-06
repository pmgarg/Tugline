/**
 * Browser automation (SPEC E1–E8). Importing this module registers the
 * browser_* tool provider, its agent extension and the `tug replay` command.
 */
import './tools.js';
import '../recorder/cli.js';
import './extension/cli.js';
import '../recorder/skillcli.js';

export { PlaywrightBrowserDriver, type DriverActResult, type DriverHooks, type DriverOptions, type TargetInfo, type Guard } from './driver.js';
export { BrowserSession, getBrowserSession, peekBrowserSession, closeBrowserSession, closeAllBrowserSessions } from './session.js';
export { browserConfig, perceptionConfig, DEFAULT_BROWSER, type BrowserConfig, type PerceptionConfig } from './config.js';
export { startDebugChrome, installedChromiums, loadPlaywright, hasAriaRefs } from './launch.js';
export { BROWSER_TOOLS } from './tools.js';
export { runBrowserTask } from '../cascade/controller.js';
export { replayRun } from '../recorder/cli.js';
export { ExtensionHub, extensionHub, pairingToken, pairingFile, EXTENSION_PATH } from './extension/hub.js';
