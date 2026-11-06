/**
 * v1.2 N34: team tools stay out of the tool list (and out of the tool count that turns on tool search) until
 * a team is wanted: `/team` names `team_create`, and calling a hidden tool by its exact name activates it.
 * Once the agent leads or joins a team, the rest are activated. `workflow_run` is hidden the same way (the `task`
 * tool's description names both), so the default tool count, and with it tool search, is unchanged.
 */
export const TEAM_TOOLS_AFTER_CREATE = ['team_task_add', 'team_task_list', 'team_task_claim', 'team_task_update', 'team_send', 'team_status', 'team_wait', 'team_steer', 'team_stop', 'team_disband', 'team_outcome_create', 'team_outcome_attach', 'team_outcome_list', 'team_outcome_finalize'];
/** what a member sees (no lead-only tools) */
export const MEMBER_TOOLS = ['team_task_add', 'team_task_list', 'team_task_claim', 'team_task_update', 'team_send', 'team_status', 'team_outcome_create', 'team_outcome_attach', 'team_outcome_list'];
