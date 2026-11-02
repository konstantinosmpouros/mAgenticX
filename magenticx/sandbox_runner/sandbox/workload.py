"""A realistic `execute` job, timed step by step: the kind of thing an agent will
run to make files from a user's data. Writes into /out and prints one JSON line
with the seconds each step took, so the spike can compare runsc with runc."""
import json
import random
import sys
import time
from pathlib import Path

OUT = Path(sys.argv[1] if len(sys.argv) > 1 else "/out")
ROWS = 100_000
timings: dict[str, float] = {}


def step(name):
    def wrap(fn):
        start = time.perf_counter()
        fn()
        timings[name] = round(time.perf_counter() - start, 3)
        return fn
    return wrap


start_all = time.perf_counter()
import_start = time.perf_counter()
import matplotlib.pyplot as plt  # noqa: E402
import pandas as pd  # noqa: E402
from docx import Document  # noqa: E402
from pptx import Presentation  # noqa: E402
from reportlab.pdfgen import canvas  # noqa: E402
timings["import"] = round(time.perf_counter() - import_start, 3)

state = {}


@step("csv")
def _csv():
    rng = random.Random(7)
    regions = ["North", "South", "East", "West"]
    rows = [
        (f"2026-{rng.randint(1, 12):02d}-{rng.randint(1, 28):02d}", rng.choice(regions), rng.randint(1, 500))
        for _ in range(ROWS)
    ]
    df = pd.DataFrame(rows, columns=["date", "region", "amount"])
    df.to_csv(OUT / "sales.csv", index=False)
    state["df"] = pd.read_csv(OUT / "sales.csv", parse_dates=["date"])


@step("pandas")
def _pandas():
    df = state["df"]
    state["monthly"] = df.groupby([df["date"].dt.month, "region"])["amount"].sum().unstack()


@step("xlsx")
def _xlsx():
    state["monthly"].to_excel(OUT / "report.xlsx")


@step("chart")
def _chart():
    ax = state["monthly"].plot(kind="bar", figsize=(8, 4))
    ax.set_title("Sales by month and region")
    plt.tight_layout()
    plt.savefig(OUT / "chart.png", dpi=120)
    plt.close("all")


@step("docx")
def _docx():
    doc = Document()
    doc.add_heading("Sales report", 0)
    doc.add_paragraph(f"{ROWS:,} rows, {len(state['monthly'])} months.")
    doc.add_picture(str(OUT / "chart.png"))
    doc.save(OUT / "report.docx")


@step("pptx")
def _pptx():
    deck = Presentation()
    slide = deck.slides.add_slide(deck.slide_layouts[5])
    slide.shapes.title.text = "Sales by month"
    slide.shapes.add_picture(str(OUT / "chart.png"), 0, 1_500_000)
    deck.save(OUT / "report.pptx")


@step("pdf")
def _pdf():
    page = canvas.Canvas(str(OUT / "report.pdf"))
    page.drawString(72, 800, "Sales report")
    page.drawImage(str(OUT / "chart.png"), 72, 450, width=450, height=225)
    page.save()


timings["total"] = round(time.perf_counter() - start_all, 3)
files = sorted(p.name for p in OUT.iterdir())
print(json.dumps({"timings": timings, "files": files}))
