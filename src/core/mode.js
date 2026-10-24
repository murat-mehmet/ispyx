// Which role this process plays. Pure (no platform import), so the entry point can decide before loading anything.
//   classic   npx on macOS / Linux / fake: every process is an MCP server, one of them owns the pipe
//             (Ispyx.app passes --resident / mcp explicitly)
//   launcher  Windows, no args, console attached: start the resident app if needed, then exit
//   resident  `--resident`: the single owner of the pipe (tray, panel, tool queue); no stdio
//   mcp       `mcp`: thin stdio MCP server forwarding every call to the resident
//   quit      `quit`: ask the resident to exit
// Explicit arguments work on any platform (tests use them with the fake platform). Without arguments only
// Windows changes: a console means launcher, a pipe on stdin (an old MCP registration) means mcp.
export function resolveMode(argv = process.argv.slice(2), env = process.env, platform = process.platform, isTTY = !!process.stdin.isTTY) {
  if (argv.includes('--resident')) return 'resident';
  if (argv.includes('mcp')) return 'mcp';
  if (argv.includes('quit') || argv.includes('--quit')) return 'quit';
  const target = env.ISPYX_PLATFORM || platform;
  if (target === 'win32') return isTTY ? 'launcher' : 'mcp';
  return 'classic';
}
