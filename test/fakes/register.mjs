import * as mod from 'node:module';

const FAKES = {
  sdk: new URL('./sdk.js', import.meta.url).href,
  'sdk/api': new URL('./sdk.js', import.meta.url).href,
  'sdk/fetch': new URL('./sdk.js', import.meta.url).href,
  'sdk/db': new URL('./sdk-db.js', import.meta.url).href,
};

// Maps the platform's bare `sdk` specifiers to the test fakes.
if (mod.registerHooks) {
  mod.registerHooks({
    resolve(specifier, context, next) {
      if (specifier in FAKES) return { url: FAKES[specifier], shortCircuit: true };
      return next(specifier, context);
    },
  });
} else {
  mod.register('./hooks.mjs', import.meta.url);
}
