/**
 * WS8 registrations (SPEC H1–H4, H6, I2): CLI subcommands, the telemetry
 * extension and the channel commands. Imported once from tools/providers.ts.
 */
import './cli.js'; // tug schedule, tug daemon
import '../telemetry/otel.js'; // H4 (inactive unless configured)
import '../eval/commands.js'; // tug review, tug arena, tug bench
import '../../channels/cli.js'; // tug channels
import '../workspace/extension.js'; // v1.1 R9: workspace lease for every agent run
import '../workspace/cli.js'; // tug lease
export {};
