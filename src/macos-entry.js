// Entry point used by the Ispyx.app launcher (Contents/Resources/ispyx). Picks the platform automatically
// (darwin), whatever the environment of the MCP client says, then runs the normal server.
delete process.env.ISPYX_PLATFORM;
await import('./core/server.js');
