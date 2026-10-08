// The async-hooks fallback of register.mjs, for Node versions without
// module.registerHooks.
const FAKES = {
  sdk: new URL('./sdk.js', import.meta.url).href,
  'sdk/api': new URL('./sdk.js', import.meta.url).href,
  'sdk/fetch': new URL('./sdk.js', import.meta.url).href,
  'sdk/db': new URL('./sdk-db.js', import.meta.url).href,
};

export async function resolve(specifier, context, next) {
  if (specifier in FAKES) return { url: FAKES[specifier], shortCircuit: true };
  return next(specifier, context);
}
