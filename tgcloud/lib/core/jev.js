// The only module that talks to the TypeSafe API.
//
// Every question is atomic on purpose: TypeSafe evaluates them in parallel
// against the same state, so asking six narrow questions costs about as much
// as one broad one and gives the policy something to combine in code.
//
// The Python bot used typesafe-sdk; the platform has no packages, so this
// speaks the SDK's wire format directly - the request body below is the one
// typesafe-sdk 0.7 sends, byte for byte.
import { fetch } from 'sdk';

import * as config from '../config.js';
import * as settings from '../storage/settings.js';
import { Verdict } from './verdict.js';

export const SYSTEM_ONE_PATH = '/v1/systemone';

export const SEVERITY_RUBRIC = [
  "Harmless self-promotion or an on-topic mention of the author's own work",
  'Clear unsolicited spam: advertising or mass-posted content nobody asked for',
  'Active fraud: an attempt to take money, credentials or accounts from the reader',
];

export const QUESTIONS = {
  is_spam: {
    type: 'noul',
    instructions: 'The message is unsolicited promotion, advertising, or mass-posted content.',
  },
  is_scam: {
    type: 'noul',
    instructions: 'The message attempts to defraud the reader: fake earnings, crypto giveaways, '
      + 'phishing, impersonated support, or requests for credentials or a seed phrase.',
  },
  solicits_contact: {
    type: 'noul',
    instructions: 'The message pushes the reader to move to a private message or an external channel.',
  },
  looks_like_member: {
    type: 'noul',
    instructions: "This reads as an ordinary message from a member of this community, given the group's topic.",
  },
  kind: {
    type: 'choice',
    instructions: 'Which category best describes this message',
    criteria: {
      crypto: 'Crypto investment, trading signals, giveaways or wallet drainers',
      job_mule: 'Fake job or easy-money offer, often money-mule recruitment',
      phishing: 'Credential theft, fake login or fake support',
      porn: 'Adult content or dating spam',
      channel_promo: 'Promoting another channel, group or bot',
      impersonation: 'Pretending to be an admin, support or a known brand',
      none: 'Not spam of any kind',
    },
  },
  severity: {
    type: 'score',
    instructions: 'How harmful this message is to the group',
    criteria: SEVERITY_RUBRIC,
  },
};

// Any failure reaching or parsing a Jev answer.
export class JevError extends Error {
  constructor(message) {
    super(message);
    this.name = 'JevError';
  }
}

// The statuses typesafe-sdk retries by default.
function retryable(status) {
  return status === 408 || status === 429 || (status >= 500 && status < 600);
}

class Timeout extends Error {}

// Races a call against the time budget. The SDK's fetch may or may not
// honour an AbortSignal, so the race is what enforces the budget; the
// signal only lets a fetch that does honour it stop early.
async function withTimeout(seconds, run) {
  if (typeof setTimeout !== 'function') return run(undefined);
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let timer;
  const expired = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      if (controller) controller.abort();
      reject(new Timeout());
    }, seconds * 1000);
  });
  try {
    return await Promise.race([run(controller ? controller.signal : undefined), expired]);
  } finally {
    clearTimeout(timer);
  }
}

function number(value, what) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new JevError(`unexpected Jev response shape: ${what} is ${JSON.stringify(value)}`);
  }
  return value;
}

export class TypeSafeJevClient {
  // apiKey defaults to the one stored with endpoints/ops_set_secret; model and
  // timeout to config. Nothing is read until classify() is called.
  constructor({ apiKey = null, model = null, timeout = null, baseUrl = null, retries = 1 } = {}) {
    this.apiKey = apiKey;
    this.model = model || config.JEV_MODEL;
    this.timeout = timeout || config.JEV_TIMEOUT;
    this.baseUrl = baseUrl || config.TYPESAFE_BASE_URL;
    this.retries = retries;
  }

  async key() {
    if (this.apiKey) return this.apiKey;
    let stored;
    try {
      stored = await settings.get(settings.TYPESAFE_API_KEY);
    } catch (exc) {
      if (exc instanceof TypeError || exc instanceof ReferenceError) throw exc;
      throw new JevError(`could not read the TypeSafe API key: ${exc.message}`);
    }
    if (!stored) throw new JevError('TYPESAFE_API_KEY is not set');
    return stored.trim();
  }

  async classify(state) {
    const key = await this.key();
    const body = JSON.stringify({ state, model: this.model, questions: QUESTIONS });
    let lastError = null;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      let response;
      try {
        response = await withTimeout(this.timeout, (signal) => fetch(this.baseUrl + SYSTEM_ONE_PATH, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${key}`,
            Accept: 'application/json',
            'Content-Type': 'application/json',
            ...(attempt ? { 'X-TypeSafe-Retry-Count': String(attempt) } : {}),
          },
          body,
          ...(signal ? { signal } : {}),
        }));
      } catch (exc) {
        // fetch rejects only when no HTTP response arrived at all.
        lastError = exc instanceof Timeout
          ? new JevError(`jev timed out after ${this.timeout}s`)
          : new JevError(`TypeSafeAPIConnectionError: ${exc.message}`);
        continue;
      }
      if (response.ok) {
        let decoded;
        try {
          decoded = await response.json();
        } catch (exc) {
          throw new JevError(`unexpected Jev response shape: ${exc.message}`);
        }
        return TypeSafeJevClient.toVerdict(decoded);
      }
      const detail = (await response.text().catch(() => '')).slice(0, 200);
      lastError = new JevError(`TypeSafeAPIError: HTTP ${response.status}: ${detail}`);
      if (!retryable(response.status)) break;
    }
    throw lastError;
  }

  static toVerdict(decoded) {
    const answers = decoded && decoded.answers;
    if (!answers || typeof answers !== 'object') {
      throw new JevError('unexpected Jev response shape: no answers');
    }
    const get = (name) => {
      if (!(name in answers) || !answers[name] || typeof answers[name] !== 'object') {
        throw new JevError(`unexpected Jev response shape: missing answer ${name}`);
      }
      return answers[name];
    };
    const kind = get('kind').choice;
    if (typeof kind !== 'string') throw new JevError('unexpected Jev response shape: kind.choice');
    const severity = get('severity');
    return Verdict({
      is_spam: number(get('is_spam').noul, 'is_spam.noul'),
      is_scam: number(get('is_scam').noul, 'is_scam.noul'),
      solicits_contact: number(get('solicits_contact').noul, 'solicits_contact.noul'),
      looks_like_member: number(get('looks_like_member').noul, 'looks_like_member.noul'),
      kind,
      // int() in the Python: the expected score, truncated to its level.
      severity: Math.trunc(number(severity.score, 'severity.score')),
      severity_confidence: number(severity.confidence, 'severity.confidence'),
      model: typeof decoded.model === 'string' ? decoded.model : 'jev',
    });
  }
}
