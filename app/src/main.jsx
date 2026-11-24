import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';

import { ChatList } from './ChatList.jsx';
import { ChatSettings } from './ChatSettings.jsx';
import { syncChat, uiLang } from './logic.js';
import './styles.css';

function App({ lang }) {
  const [chatId, setChatId] = useState(null);
  const [chats, setChats] = useState(null);
  const tg = window.Telegram.WebApp;

  useEffect(() => {
    if (chatId === null) {
      tg.BackButton.hide();
      return undefined;
    }
    const back = () => setChatId(null);
    tg.BackButton.show();
    tg.BackButton.onClick(back);
    return () => tg.BackButton.offClick(back);
  }, [chatId]);

  const onSync = (view) => setChats((prev) => syncChat(prev, view));

  // The list stays mounted (hidden) so going back does not refetch it and
  // spend the 3-per-minute listing budget.
  return (
    <>
      <div hidden={chatId !== null}>
        <ChatList lang={lang} chats={chats} onLoad={setChats} onOpen={setChatId} />
      </div>
      {chatId !== null && <ChatSettings lang={lang} chatId={chatId} onSync={onSync} />}
    </>
  );
}

function start() {
  const tg = window.Telegram.WebApp;
  tg.ready();
  tg.expand();
  const user = tg.initDataUnsafe && tg.initDataUnsafe.user;
  render(<App lang={uiLang(user && user.language_code)} />, document.getElementById('root'));
}

// Outside Telegram (npm run dev in a browser) there is no init data; the
// stub fakes the WebApp object. import.meta.env.DEV is false in a build,
// so the stub never reaches dist/.
if (import.meta.env.DEV && !(window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initData)) {
  import('./dev_stub.js').then(start);
} else {
  start();
}
