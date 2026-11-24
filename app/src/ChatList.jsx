import { useEffect, useState } from 'preact/hooks';

import { call } from './api.js';
import { tr } from './i18n.js';
import { badge, errorKey } from './logic.js';

export function ChatList({ lang, chats, onLoad, onOpen }) {
  const [error, setError] = useState(null);

  useEffect(() => {
    call('app_chats').then((r) => onLoad(r.chats), (e) => setError(errorKey(e)));
  }, []);

  if (error) return <p class="note">{tr(lang, error)}</p>;
  if (chats === null) return <p class="note">{tr(lang, 'loading')}</p>;
  return (
    <main>
      <h1>{tr(lang, 'title')}</h1>
      {chats.length === 0 && <p class="note">{tr(lang, 'empty')}</p>}
      {chats.map((c) => {
        const b = badge(c);
        return (
          <button class="card" key={c.chat_id} onClick={() => onOpen(c.chat_id)}>
            <span class="card-title">{c.title}</span>
            <span class={`badge ${b.key}`}>{tr(lang, b.key, { days: b.days })}</span>
          </button>
        );
      })}
    </main>
  );
}
