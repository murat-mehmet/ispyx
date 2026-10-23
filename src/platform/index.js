// Picks the platform layer for this OS. Every platform folder exports the same API (see CONTRACT.md); the rest
// of the code imports this module and never a platform folder directly.
const IMPLEMENTATIONS = {
  win32: './win32/index.js',
  darwin: './darwin/index.js',
  linux: './linux/index.js',
};

const target = process.env.ISPYX_PLATFORM || process.platform; // ISPYX_PLATFORM=fake runs the core without a desktop (tests)
const path = target === 'fake' ? './fake/index.js' : IMPLEMENTATIONS[target];
if (!path) throw new Error(`ispyx does not support ${process.platform} yet.`);

export default await import(path);
