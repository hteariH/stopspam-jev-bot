// Builds the structured state Jev evaluates.
//
// Jev is built for structured program state, so we hand it a labelled
// document rather than raw text: identical wording means different things
// from a five-year member and from an account that joined ninety seconds ago.
import { slice } from '../html.js';
import { fixed } from '../pyfmt.js';

export const MAX_TEXT = 2000;

const URL_RE = /(?:https?:\/\/|www\.|t\.me\/)[^\s<>()]+/gi;
const INVITE_RE = /(?:t\.me\/(?:joinchat\/|\+)|telegram\.me\/joinchat\/)/i;

const MEDIA_ATTRS = ['photo', 'video', 'animation', 'document', 'audio', 'voice',
  'video_note', 'sticker'];

export function MessageFacts(fields) {
  return Object.freeze({ ...fields });
}

const SCHEME_CHARS = /^[A-Za-z0-9+\-.]+$/;

// ipaddress.ip_address(...) accepting only IPv6, as urllib checks a
// bracketed host.
function isIPv6(host) {
  let addr = host;
  const zone = addr.indexOf('%');
  if (zone !== -1) {
    if (zone === addr.length - 1) return false;
    addr = addr.slice(0, zone);
  }
  let groups = 8;
  const lastColon = addr.lastIndexOf(':');
  if (lastColon !== -1 && addr.slice(lastColon + 1).includes('.')) {
    const v4 = addr.slice(lastColon + 1).split('.');
    if (v4.length !== 4 || !v4.every((o) => /^\d{1,3}$/.test(o) && Number(o) <= 255
        && !(o.length > 1 && o[0] === '0'))) return false;
    addr = addr.slice(0, lastColon + 1) + '0:0';
  }
  const halves = addr.split('::');
  if (halves.length > 2) return false;
  const part = (s) => (s === '' ? [] : s.split(':'));
  const head = part(halves[0]);
  const tail = halves.length === 2 ? part(halves[1]) : [];
  const valid = (g) => /^[0-9A-Fa-f]{1,4}$/.test(g);
  if (![...head, ...tail].every(valid)) return false;
  if (halves.length === 2) return head.length + tail.length <= groups - 1;
  return head.length === groups;
}

// urllib.parse.urlsplit(url).netloc, including the ValueErrors it raises on
// malformed brackets; null where Python would raise.
function netloc(url) {
  let rest = url;
  const colon = rest.indexOf(':');
  if (colon > 0 && /^[A-Za-z]/.test(rest) && SCHEME_CHARS.test(rest.slice(0, colon))) {
    rest = rest.slice(colon + 1);
  }
  if (!rest.startsWith('//')) return '';
  let end = rest.length;
  for (const c of '/?#') {
    const at = rest.indexOf(c, 2);
    if (at !== -1 && at < end) end = at;
  }
  const loc = rest.slice(2, end);
  const open = loc.includes('['), close = loc.includes(']');
  if (open !== close) return null;
  if (open) {
    const hostAndPort = loc.slice(loc.lastIndexOf('@') + 1);
    const bracket = hostAndPort.indexOf('[');
    if (bracket !== -1) {
      if (bracket > 0) return null;
      const inner = hostAndPort.slice(1);
      const closing = inner.indexOf(']');
      const hostname = closing === -1 ? inner : inner.slice(0, closing);
      const port = closing === -1 ? '' : inner.slice(closing + 1);
      if (port && !port.startsWith(':')) return null;
      if (hostname.startsWith('v')) {
        if (!/^v[a-fA-F0-9]+\..+$/s.test(hostname)) return null;
      } else if (!isIPv6(hostname)) {
        return null;
      }
    }
  }
  return loc;
}

// Extract the domain from a URL, returning "" if parsing fails.
//
// Handles malformed URLs gracefully to prevent crashes on hostile input
// (e.g., unbalanced brackets in IPv6 addresses).
export function domain(raw) {
  const candidate = raw.includes('://') ? raw : `http://${raw}`;
  const loc = netloc(candidate);
  if (loc === null) return '';
  const host = loc.toLowerCase();
  return host.startsWith('www.') ? host.slice(4) : host;
}

export function buildState(facts) {
  const age = facts.author_days_in_group === null || facts.author_days_in_group === undefined
    ? 'unknown'
    : `${fixed(facts.author_days_in_group, 1)} days`;
  const lines = [
    '# Group',
    `title: ${facts.group_title}`,
    `description: ${facts.group_description || '(none)'}`,
    '',
    '# Author',
    `messages previously sent in this group: ${facts.author_message_count}`,
    `time in this group: ${age}`,
    `has a username: ${facts.author_has_username ? 'yes' : 'no'}`,
    '',
    '# Message',
    `is a media caption: ${facts.is_caption ? 'yes' : 'no'}`,
    `media type: ${facts.media_type || '(none)'}`,
    `forwarded: ${facts.is_forward ? 'yes' : 'no'}`,
    `link count: ${facts.link_count}`,
    `link domains: ${facts.link_domains.join(', ') || '(none)'}`,
    `contains a Telegram invite link: ${facts.has_invite_link ? 'yes' : 'no'}`,
    '',
    '# Text',
    slice(facts.text, 0, MAX_TEXT),
  ];
  return lines.join('\n');
}

export function factsFromMessage(message, { authorMessageCount, authorDaysInGroup, groupDescription }) {
  const text = message.text || message.caption || '';
  const urls = text.match(URL_RE) || [];
  const mediaType = MEDIA_ATTRS.find((name) => message[name] !== undefined && message[name] !== null) || null;
  // Filter out empty domains (from unparseable URLs), keeping first-seen order.
  const domains = [...new Set(urls.map(domain).filter((d) => d))];
  const hasText = message.text !== undefined && message.text !== null;
  const hasCaption = message.caption !== undefined && message.caption !== null;
  return MessageFacts({
    text,
    link_domains: domains,
    link_count: urls.length,
    has_invite_link: INVITE_RE.test(text),
    is_forward: Boolean(message.forward_origin),
    media_type: mediaType,
    is_caption: !hasText && hasCaption,
    author_message_count: authorMessageCount,
    author_days_in_group: authorDaysInGroup,
    author_has_username: Boolean(message.from && message.from.username),
    group_title: slice(message.chat.title || '', 0, 128),
    group_description: slice(groupDescription || '', 0, 255),
  });
}
