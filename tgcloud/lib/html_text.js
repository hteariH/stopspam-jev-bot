// aiogram's Message.html_text: a received message's text and entities turned
// back into the HTML that would produce it.
//
// The review handler edits a card by appending the outcome to the card's own
// HTML, and Telegram returns only plain text plus entities. This is a port of
// aiogram.utils.text_decorations.HtmlDecoration, kept output-identical.
// Entity offsets and lengths are in UTF-16 code units, which is what a JS
// string indexes by, so no surrogate juggling is needed.

// html.escape(value, quote=False)
function quote(value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function tag(name, content, { attrs = null, flags = null } = {}) {
  const prepared = [];
  if (attrs) for (const [k, v] of Object.entries(attrs)) prepared.push(`${k}="${v}"`);
  if (flags) prepared.push(...flags);
  const attrsText = prepared.length ? ' ' + prepared.join(' ') : '';
  return `<${name}${attrsText}>${content}</${name}>`;
}

const UNCHANGED = new Set(['bot_command', 'url', 'mention', 'phone_number', 'hashtag', 'cashtag', 'email']);
const SIMPLE = {
  bold: 'b',
  italic: 'i',
  code: 'code',
  underline: 'u',
  strikethrough: 's',
  spoiler: 'tg-spoiler',
  blockquote: 'blockquote',
};

function applyEntity(entity, text) {
  if (UNCHANGED.has(entity.type)) return text;
  if (entity.type in SIMPLE) return tag(SIMPLE[entity.type], text);
  if (entity.type === 'expandable_blockquote') return tag('blockquote', text, { flags: ['expandable'] });
  if (entity.type === 'pre') {
    return entity.language
      ? tag('pre', tag('code', text, { attrs: { language: `language-${entity.language}` } }))
      : tag('pre', text);
  }
  if (entity.type === 'text_mention') return tag('a', text, { attrs: { href: `tg://user?id=${entity.user.id}` } });
  if (entity.type === 'text_link') return tag('a', text, { attrs: { href: entity.url } });
  if (entity.type === 'custom_emoji') return tag('tg-emoji', text, { attrs: { 'emoji-id': entity.custom_emoji_id } });
  if (entity.type === 'date_time') {
    const attrs = { unix: String(entity.unix_time) };
    if (entity.date_time_format) attrs.format = entity.date_time_format;
    return tag('tg-time', text, { attrs });
  }
  return quote(text);
}

function unparseEntities(text, entities, start = 0, end = null) {
  let offset = start;
  const length = end || text.length;
  const out = [];
  entities.forEach((entity, index) => {
    if (entity.offset < offset) return;
    if (entity.offset > offset) out.push(quote(text.slice(offset, entity.offset)));
    const entityStart = entity.offset;
    offset = entity.offset + entity.length;
    const sub = entities.slice(index + 1).filter((e) => e.offset < offset);
    out.push(applyEntity(entity, unparseEntities(text, sub, entityStart, offset)));
  });
  if (offset < length) out.push(quote(text.slice(offset, length)));
  return out.join('');
}

export function htmlText(message) {
  const text = (message && (message.text || message.caption)) || '';
  const entities = (message && (message.entities || message.caption_entities)) || [];
  // A stable sort by offset, as Python's sorted() is.
  const sorted = entities.map((e, i) => [e, i])
    .sort((a, b) => a[0].offset - b[0].offset || a[1] - b[1])
    .map(([e]) => e);
  return unparseEntities(text, sorted);
}
