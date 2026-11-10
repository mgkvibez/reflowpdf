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
