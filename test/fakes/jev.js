// Test double for the Jev client. Matches a substring of the state to a
// canned verdict.
import { JevError } from '../../tgcloud/lib/core/jev.js';

export class FakeJevClient {
  constructor(verdicts, { fallback = null, fail = false } = {}) {
    this.verdicts = verdicts;
    this.fallback = fallback;
    this.fail = fail;
    this.calls = [];
  }

  async classify(state) {
    this.calls.push(state);
    if (this.fail) throw new JevError('simulated outage');
    for (const [needle, verdict] of Object.entries(this.verdicts)) {
      if (state.toLowerCase().includes(needle.toLowerCase())) return verdict;
    }
    if (this.fallback === null) throw new JevError(`no canned verdict matches: ${state.slice(0, 60)}`);
    return this.fallback;
  }
}
