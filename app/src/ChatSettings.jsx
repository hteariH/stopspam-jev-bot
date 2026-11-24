import { useEffect, useRef, useState } from 'preact/hooks';

import { call } from './api.js';
import { tr } from './i18n.js';
import {
  badge, cardsKey, createPopupGuard, createSaveQueue, errorKey, fmt, STEP,
} from './logic.js';

const LANGS = ['en', 'ru', 'uk'];
// Read on use, not at import: in dev the stub installs it after this module loads.
const tg = () => window.Telegram.WebApp;

function Section({ title, children }) {
  return <section><h2>{title}</h2><div class="group">{children}</div></section>;
}

function Slider({ label, hint, value, onSave }) {
  const [draft, setDraft] = useState(null);
  useEffect(() => setDraft(null), [value]);
  const shown = draft === null ? value : draft;
  return (
    <label class="row column">
      <span class="row-line"><span>{label}</span><b>{fmt(shown)}</b></span>
      <input type="range" min="0" max="1" step={STEP} value={shown}
        onInput={(e) => setDraft(Number(e.currentTarget.value))}
        onChange={(e) => { setDraft(null); onSave(Number(e.currentTarget.value)); }} />
      <small>{hint}</small>
    </label>
  );
}

function Segments({ options, value, onPick }) {
  return (
    <div class="segments">
      {options.map(([key, label]) => (
        <button key={key} class={key === value ? 'on' : ''} onClick={() => key !== value && onPick(key)}>{label}</button>
      ))}
    </div>
  );
}

export function ChatSettings({ lang, chatId, onSync }) {
  const [view, setView] = useState(null);
  const [error, setError] = useState(null);
  const queueRef = useRef(null);
  const runPopup = useRef(null);
  if (!runPopup.current) runPopup.current = createPopupGuard();

  function showError(e) {
    runPopup.current((done) => tg().showAlert(tr(lang, errorKey(e)), done));
  }

  useEffect(() => {
    const q = createSaveQueue({
      send: (fields) => call('app_update', { chat_id: chatId, fields }),
      onView: setView,
      onServerView: onSync,
      onSaved: () => tg().HapticFeedback.impactOccurred('light'),
      onError: showError,
    });
    queueRef.current = q;
    setView(null);
    setError(null);
    let active = true;
    call('app_chat', { chat_id: chatId }).then(
      (v) => active && q.setServerView(v),
      (e) => active && setError(errorKey(e)),
    );
    return () => {
      active = false;
      q.close();
    };
  }, [chatId]);

  function save(fields) {
    if (queueRef.current) queueRef.current.save(fields);
  }

  function startDeleting() {
    runPopup.current((done) => tg().showConfirm(tr(lang, 'start_deleting_confirm'), (ok) => {
      done();
      if (ok) save({ end_observe: true });
    }));
  }

  function subscribe() {
    const q = queueRef.current;
    tg().openInvoice(view.subscribe_url, (status) => {
      if (status === 'paid') {
        call('app_chat', { chat_id: chatId }).then(
          (v) => q && q.setServerView(v),
          showError,
        );
      }
    });
  }

  if (error) return <p class="note">{tr(lang, error)}</p>;
  if (view === null) return <p class="note">{tr(lang, 'loading')}</p>;
  const plan = view.plan;
  const b = badge(view);
  return (
    <main>
      <h1>{view.title}</h1>

      <Section title={tr(lang, 'sec_moderation')}>
        <div class="row">
          <Segments value={view.mode} onPick={(mode) => save({ mode })}
            options={[['active', tr(lang, 'mode_active')], ['observe', tr(lang, 'mode_observe')]]} />
        </div>
        <label class="row column">
          <span class="row-line">
            <span>{tr(lang, 'jev')}</span>
            <input type="checkbox" class="switch" checked={view.jev_enabled}
              onChange={(e) => save({ jev_enabled: e.currentTarget.checked })} />
          </span>
          <small>{tr(lang, 'jev_hint')}</small>
        </label>
        {view.observing && (
          <div class="row column">
            <small>{tr(lang, b.key, { days: b.days })}</small>
            <button class="primary" onClick={startDeleting}>{tr(lang, 'start_deleting')}</button>
          </div>
        )}
      </Section>

      <Section title={tr(lang, 'sec_thresholds')}>
        <Slider label={tr(lang, 'delete_threshold')} hint={tr(lang, 'delete_hint')}
          value={view.delete_threshold} onSave={(v) => save({ delete_threshold: v })} />
        <Slider label={tr(lang, 'review_threshold')} hint={tr(lang, 'review_hint')}
          value={view.review_threshold} onSave={(v) => save({ review_threshold: v })} />
        <Slider label={tr(lang, 'confidence_floor')} hint={tr(lang, 'confidence_hint')}
          value={view.confidence_floor} onSave={(v) => save({ confidence_floor: v })} />
        <div class="row column">
          <span class="row-line">
            <span>{tr(lang, 'trust_after')}</span>
            <span class="stepper">
              <button disabled={view.trust_after <= 0} onClick={() => save({ trust_after: view.trust_after - 1 })}>−</button>
              <b>{view.trust_after}</b>
              <button disabled={view.trust_after >= 50} onClick={() => save({ trust_after: view.trust_after + 1 })}>+</button>
            </span>
          </span>
          <small>{tr(lang, 'trust_hint')}</small>
        </div>
      </Section>

      <Section title={tr(lang, 'sec_cards')}>
        <div class="row column">
          <span>{tr(lang, cardsKey(view.cards), { id: view.cards.id })}</span>
          {view.cards.kind !== 'me' && <button onClick={() => save({ log_to_me: true })}>{tr(lang, 'cards_to_me')}</button>}
        </div>
      </Section>

      <Section title={tr(lang, 'sec_lang')}>
        <div class="row">
          <Segments value={view.lang} onPick={(l) => save({ lang: l })}
            options={LANGS.map((l) => [l, l.toUpperCase()])} />
        </div>
      </Section>

      <Section title={tr(lang, 'sec_plan')}>
        <div class="row column">
          <span>{tr(lang, `plan_${plan.kind}`, plan)}</span>
          {view.subscribe_url && (
            <button class="primary" onClick={subscribe}>{tr(lang, 'subscribe', { stars: view.subscribe_stars })}</button>
          )}
        </div>
      </Section>
    </main>
  );
}
