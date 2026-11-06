/**
 * V0.1 drivers for the WS17 surfaces: a TEAMMATE (N34) and a WORKFLOW ITEM (N18).
 *
 * The lead is built the way an application builds an agent (the TypeScript SDK's `createAgent`: loadConfig from the
 * workspace and $HOME, trust, managed policy) and runs a real turn: the scripted model makes it hand the scenario on
 *  - to a teammate: `team_create` (one member whose instructions are the prompt, in the shared workspace), then
 *    `team_wait` and `team_disband` (TEAM_MARKER);
 *  - to a workflow item: `workflow_run` with one item whose task prompt is the prompt (WORKFLOW_MARKER).
 * So every hostile action is taken by the child and meets the same controls (S1, S2). Every approval the child
 * raises reaches the human through the lead's approval channel (badged for a teammate) and is answered there.
 */
import { createAgent } from '../../../src/sdk/index.js';
import type { AgentEvent } from '../../../src/core/types.js';
import { TEAM_MARKER, WORKFLOW_MARKER } from '../harness.js';
import type { HumanPrompt, ScenarioContext, SurfaceDriver, SurfaceResult } from '../types.js';

async function viaLead(ctx: ScenarioContext, marker: string, how: string): Promise<SurfaceResult> {
  const out: string[] = [];
  const prompts: HumanPrompt[] = [];
  const agent = await createAgent({
    workspace: ctx.workspace,
    mcp: false,
    onEvent: (e: AgentEvent) => {
      if (e.type === 'text_delta') out.push(e.text);
      else if (e.type === 'tool_end') out.push(String(e.output ?? ''));
      else if (e.type === 'notice') out.push(e.message);
    },
    onPermission: async (req) => {
      const p = { tool: req.tool, title: req.title, detail: req.detail, reason: req.reason };
      prompts.push(p);
      return { decision: await ctx.human(p) };
    },
  });
  ctx.defer(() => agent.dispose());
  const r = await agent.run(`${marker}: ${how}: ${ctx.prompt}`);
  out.push(r.finalText ?? '');
  return { stopReason: r.stopReason, finalText: r.finalText, output: out.join('\n'), prompts };
}

const teammate: SurfaceDriver = {
  id: 'teammate',
  label: 'Teammate (agent team member, N34)',
  run: (ctx) => viaLead(ctx, TEAM_MARKER, 'create a team with one member and give it this task'),
};

const workflowItem: SurfaceDriver = {
  id: 'workflow-item',
  label: 'Workflow item (workflow_run, N18)',
  run: (ctx) => viaLead(ctx, WORKFLOW_MARKER, 'run this as a one-item workflow'),
};

/** Both WS17 surfaces (the harness loads every SurfaceDriver a driver file exports, arrays included). */
export const teamsDrivers: SurfaceDriver[] = [teammate, workflowItem];
