#!/usr/bin/env node
// Entry point (bin `ispyx`; existing MCP registrations point here too).
//   ispyx            Windows with a console: start the resident app if needed, then exit
//   ispyx --resident the resident app (tray, panel, tool queue)
//   ispyx mcp        stdio MCP server forwarding to the resident (started on demand)
//   ispyx quit       ask the resident to exit
//   ispyx update     stop the resident, npm install -g ispyx@latest, start it again
// Windows without a console on stdin (an old MCP registration) behaves as `mcp`. Other platforms run the
// classic server (core/server.js), unchanged. See src/core/RESIDENT.md.
import { resolveMode } from "./core/mode.js";

const mode = resolveMode();
if (mode === "launcher") await (await import("./core/launcher.js")).runLauncher();
else if (mode === "quit") await (await import("./core/launcher.js")).runQuit();
else if (mode === "update") await (await import("./core/launcher.js")).runUpdate();
else await import("./core/server.js");
