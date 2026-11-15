// path for a mod under test: the test's own join when it set one (globalThis.__fs.join), else
// the real path module. A default export too, so `import path from "node:path"` still works.
import * as real from "node:path";

export const join = (...parts) => (globalThis.__fs?.join ?? real.join)(...parts);
export const dirname = real.dirname;
export const basename = real.basename;
export const extname = real.extname;
export const resolve = real.resolve;
export const relative = real.relative;
export const sep = real.sep;

export default { ...real, join };
