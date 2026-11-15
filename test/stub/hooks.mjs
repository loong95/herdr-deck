// Maps the modules a mod imports to the fakes. Everything else resolves as usual.
const map = {
  "gpui-kit": "./kit.mjs",
  "gpui-base": "./base.mjs",
  herdr: "./herdr.mjs",
  // pi-sessions reads the session folder itself; the test drives it through the fake.
  "fs/promises": "./fs.mjs",
  path: "./path.mjs",
};

export async function resolve(specifier, context, next) {
  const hit = map[specifier];
  if (hit) return { url: new URL(hit, import.meta.url).href, shortCircuit: true };
  return next(specifier, context);
}
