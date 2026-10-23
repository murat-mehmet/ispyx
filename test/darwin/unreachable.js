// Child of client.js: the app cannot be reached; prints the error a tool call would get.
import * as d from '../../src/platform/darwin/index.js';

try {
  d.cursorPos();
  console.log('NOERR');
} catch (e) {
  console.log(e.message);
}
process.exit(0);
