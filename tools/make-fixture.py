"""Generate tests/fixtures/article.pdf, the real-world fixture the round-trip test edits.

Committed as a binary so the test suite needs no PDF toolchain: this script is the provenance record, not a build step.
ReportLab writes a normal one-page PDF with compressed content streams, a classic xref table, and three text lines
drawn as separate show operators, which is what a real document looks like.

    python3 -m pip install reportlab && python3 tools/make-fixture.py
"""

from reportlab.pdfgen import canvas

OUT = "tests/fixtures/article.pdf"

c = canvas.Canvas(OUT, pagesize=(595, 842))  # A4
c.setFont("Helvetica-Bold", 18)
c.drawString(72, 760, "Browser PDF editing")
c.setFont("Helvetica", 11)
c.drawString(72, 730, "The quick brown fox jumps over the lazy dog.")
c.drawString(72, 714, "Nothing open sits in the middle of reading and creating.")
c.drawString(72, 698, "Reflow is the feature every reader eventually asks for.")
c.showPage()
c.save()
print("wrote", OUT)

# The second fixture exists to prove advance is measured, not assumed: it embeds a TrueType font, so the file carries a
# real /Widths table (the base-14 fonts above carry none, which is why that fixture can only demonstrate the fallback).
# DejaVu Sans is used because it is present on any Debian-family image; the path is searched rather than assumed.
import os
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

CANDIDATES = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/dejavu/DejaVuSans.ttf",
    "/Library/Fonts/Arial.ttf",
]
for path in CANDIDATES:
    if os.path.exists(path):
        FONT_PATH = path
        break
else:
    raise SystemExit(f"no TrueType font found; looked in {CANDIDATES}")

pdfmetrics.registerFont(TTFont("Body", FONT_PATH))
OUT_TTF = "tests/fixtures/article-ttf.pdf"
c = canvas.Canvas(OUT_TTF, pagesize=(595, 842))
c.setFont("Body", 12)
c.drawString(72, 760, "Widths, not guesses")
c.setFont("Body", 11)
c.drawString(72, 730, "The rest of this line has to stay in its column.")
c.drawString(72, 700, "left run")
c.drawString(180, 700, "right run")
c.showPage()
c.save()

print("wrote", OUT_TTF, "with", FONT_PATH)
print("advance of 'Widths, not guesses' at 12pt:", pdfmetrics.stringWidth("Widths, not guesses", "Body", 12))
print("advance of 'left run' at 11pt:", pdfmetrics.stringWidth("left run", "Body", 11))
print("advance of 'left run, but longer' at 11pt:", pdfmetrics.stringWidth("left run, but longer", "Body", 11))
