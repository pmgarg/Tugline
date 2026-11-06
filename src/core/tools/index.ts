import type { ToolDef } from './types.js';
import { editTools, globTool, grepTool, listDirTool, readFileTool } from './fs.js';
import { bashTool } from './shell.js';
import { webFetchTool, webSearchTool } from './web.js';
import { screenshotTool } from './screenshot.js';
import { askUserTool, exitPlanModeTool, loadSkillTool, taskTool, todoWriteTool } from './meta.js';
import type { HarnessConfig } from '../config.js';

export * from './types.js';

export function builtinTools(cfg: HarnessConfig): ToolDef[] {
  // Edit tools: one family per session, chosen per model (SPEC A7).
  const tools: ToolDef[] = [readFileTool, listDirTool, globTool, grepTool, ...editTools(cfg), bashTool, todoWriteTool, loadSkillTool, taskTool, askUserTool, exitPlanModeTool, screenshotTool];
  if (cfg.web.searchProvider !== 'none') tools.push(webSearchTool, webFetchTool);
  return tools;
}

export const READ_ONLY_TOOLS = ['read_file', 'list_dir', 'glob', 'grep', 'web_search', 'web_fetch', 'load_skill', 'todo_write', 'screenshot'];

/** Tool sets for built-in subagent types. */
export function toolsForAgentType(all: ToolDef[], type: string, explicit?: string[]): ToolDef[] {
  if (explicit?.length) return all.filter((t) => explicit.includes(t.name) || explicit.some((e) => e.endsWith('*') && t.name.startsWith(e.slice(0, -1))));
  switch (type) {
    case 'explore':
      return all.filter((t) => (READ_ONLY_TOOLS.includes(t.name) || (t.readOnly && t.kind !== 'mcp')) && t.name !== 'todo_write');
    case 'validator':
      return all.filter((t) => ([...READ_ONLY_TOOLS, 'bash'].includes(t.name) || (t.readOnly && t.kind !== 'mcp')) && t.name !== 'todo_write');
    default:
      return all.filter((t) => !['task', 'exit_plan_mode', 'ask_user'].includes(t.name));
  }
}
