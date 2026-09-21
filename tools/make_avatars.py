"""Regenerate the bot's avatar and its alternates.

Telegram crops avatars to a circle and renders them as small as 30px in a chat
list, so these are drawn as marks rather than pictures: full-bleed background,
mark inside the central ~70%, no text, two colours plus white. Everything is
drawn at 2048 and downsampled, which is cheaper than antialiasing by hand.

    python tools/make_avatars.py
"""
import math
from PIL import Image, ImageDraw

S, OUT = 2048, 512
INK, NAVY, RED = (255, 255, 255), (30, 42, 71), (255, 77, 79)
OUT_DIR = "brand"


def canvas(bg):
    im = Image.new("RGB", (S, S), bg)
    return im, ImageDraw.Draw(im)


def bubble(d, cx, cy, w, h, r, fill):
    d.rounded_rectangle([cx - w // 2, cy - h // 2, cx + w // 2, cy + h // 2],
                        radius=r, fill=fill)
    bx, by = cx - w // 2 + int(w * 0.20), cy + h // 2 - 6
    d.polygon([(bx, by), (bx + int(w * 0.26), by),
               (bx - int(w * 0.04), by + int(h * 0.30))], fill=fill)


def thick_line(d, p1, p2, width, fill):
    """A line with round caps — ImageDraw's joint option does not cap ends."""
    d.line([p1, p2], fill=fill, width=width)
    for p in (p1, p2):
        d.ellipse([p[0] - width // 2, p[1] - width // 2,
                   p[0] + width // 2, p[1] + width // 2], fill=fill)


def qbez(p0, p1, p2, n=80):
    return [((1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * p1[0] + t * t * p2[0],
             (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * p1[1] + t * t * p2[1])
            for t in (i / n for i in range(n + 1))]


def shield(cx, cy, w, h):
    """Flat shoulders, sides bowing inward to a single clean point."""
    top, bot, half = cy - h // 2, cy + h // 2, w // 2
    pts = [(cx - half, top), (cx + half, top)]
    pts += qbez((cx + half, top), (cx + half, top + h * 0.62), (cx, bot))
    pts += qbez((cx, bot), (cx - half, top + h * 0.62), (cx - half, top))
    return pts


def save(im, name):
    im.resize((OUT, OUT), Image.LANCZOS).save(f"{OUT_DIR}/{name}", "PNG")
    print("wrote", name)


def struck_bubble():
    """In use: a message, struck through."""
    im, d = canvas(NAVY)
    c = S // 2
    bubble(d, c, c - 40, 1120, 840, 210, INK)
    # A navy pass under the red one separates the bar from the white bubble.
    thick_line(d, (c - 430, c - 430), (c + 430, c + 330), 250, NAVY)
    thick_line(d, (c - 400, c - 400), (c + 400, c + 300), 150, RED)
    save(im, "avatar-a-struck-bubble.png")


def shielded_chat():
    im, d = canvas(NAVY)
    c = S // 2
    d.polygon(shield(c, c + 20, 1120, 1360), fill=INK)
    bubble(d, c, c - 110, 600, 450, 115, NAVY)
    save(im, "avatar-b-shielded-chat.png")


def stop_message():
    im, d = canvas(NAVY)
    c, r = S // 2, 790
    d.polygon([(c + r * math.cos(math.radians(a)), c + r * math.sin(math.radians(a)))
               for a in range(22, 382, 45)], fill=RED)
    bubble(d, c, c - 30, 820, 600, 160, INK)
    save(im, "avatar-c-stop-message.png")


def contact_sheet(names, sizes=(200, 96, 48, 30)):
    """Circle-cropped, at the sizes Telegram actually renders."""
    pad, gap_x, gap_y = 40, 60, 46
    width = pad * 2 + sum(sizes) + gap_x * (len(sizes) - 1)
    height = pad * 2 + len(names) * (max(sizes) + gap_y)
    sheet = Image.new("RGB", (width, height), (245, 246, 248))
    for row, name in enumerate(names):
        src = Image.open(f"{OUT_DIR}/{name}").convert("RGB")
        y, x = pad + row * (max(sizes) + gap_y), pad
        for size in sizes:
            thumb = src.resize((size, size), Image.LANCZOS)
            mask = Image.new("L", (size * 4, size * 4), 0)
            ImageDraw.Draw(mask).ellipse([0, 0, size * 4 - 1, size * 4 - 1], fill=255)
            thumb.putalpha(mask.resize((size, size), Image.LANCZOS))
            sheet.paste(thumb, (x, y + (max(sizes) - size) // 2), thumb)
            x += size + gap_x
    sheet.save(f"{OUT_DIR}/preview-at-real-sizes.png", "PNG")
    print("wrote preview-at-real-sizes.png")


if __name__ == "__main__":
    struck_bubble()
    shielded_chat()
    stop_message()
    contact_sheet(["avatar-a-struck-bubble.png",
                   "avatar-b-shielded-chat.png",
                   "avatar-c-stop-message.png"])
