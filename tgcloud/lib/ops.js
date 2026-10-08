// The guard every ops endpoint runs first.
//
// `tgcloud run` can only run modules in handlers/ and endpoints/, so one-off
// operations (writing the TypeSafe key, importing the old database) are
// endpoints. An endpoint is also reachable over HTTP from a Mini App, but
// the platform only runs it there with verified Mini App init data in
// ctx.initData. `tgcloud run --ctx '{ops:true}'` is authenticated with the
// project token and passes its ctx through as given. So: no init data and an
// explicit ops flag means the call came from the CLI, and anything else is
// refused before it can read or write a thing.
import { EndpointError } from 'sdk';

export function requireOps(ctx) {
  if (!ctx || ctx.ops !== true || ctx.initData !== undefined) {
    throw new EndpointError('forbidden', { code: 'FORBIDDEN' });
  }
}
