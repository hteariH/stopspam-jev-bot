# Brand assets

The bot's avatar and the alternates it was chosen from.

**In use: `avatar-a-struck-bubble.png`** — a message struck through. Set on
[@StopSpam_jev_bot](https://t.me/StopSpam_jev_bot) via BotFather's `/setuserpic`.

| File | Mark | Note |
|---|---|---|
| `avatar-a-struck-bubble.png` | A message, struck through | In use. Reads most literally at large sizes; the red bar thins out below ~48px. |
| `avatar-b-shielded-chat.png` | A conversation under a shield | Keeps its silhouette down to 30px, but monochrome and quiet in a chat list. |
| `avatar-c-stop-message.png` | A message inside a stop sign | Holds up best at the smallest sizes; the red carries in a list of blue icons. |
| `preview-at-real-sizes.png` | — | All three circle-cropped at 200, 96, 48 and 30px, the sizes Telegram actually renders. |

## Constraints these were drawn against

- **Telegram crops avatars to a circle.** The background is full-bleed and the mark
  stays inside the central ~70%, so nothing important sits where the crop lands.
- **512×512 PNG**, drawn at 2048 and downsampled for clean edges.
- No text. At 30px a glyph is a smudge, so the mark has to carry the meaning alone.
- Two colours plus white: `#1E2A47` navy, `#FF4D4F` red.

Regenerate or adjust with `tools/make_avatars.py`.
