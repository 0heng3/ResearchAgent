"""Render README figures from frozen, compact evidence. No Agent/model calls.

Optional documentation dependency: matplotlib. Existing results are read-only;
only docs/assets is written. These figures are not new benchmark runs.
"""
from __future__ import annotations

import json
import math
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("MPLCONFIGDIR", str(ROOT / "artifacts" / "readme-render-cache"))
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch, Patch
from matplotlib.ticker import PercentFormatter

ASSETS = ROOT / "docs" / "assets"
NAVY = "#21364F"
TEAL = "#087F8C"
ORANGE = "#C87815"
GREY = "#52657B"
LIGHT = "#F2F6FA"
BORDER = "#D7E2EC"


def load(name):
    return json.loads((ROOT / name).read_text(encoding="utf-8"))


def style():
    plt.rcParams.update({
        "font.family": "DejaVu Sans", "font.size": 13,
        "axes.spines.top": False, "axes.spines.right": False,
        "axes.spines.left": False, "axes.edgecolor": BORDER,
        "axes.labelcolor": GREY, "xtick.color": GREY, "ytick.color": NAVY,
        "text.color": NAVY, "figure.facecolor": "white",
        "axes.facecolor": "white", "svg.hashsalt": "ResearchAgent-frozen-readme-v1",
    })


def save(fig, name, svg=False):
    fig.savefig(ASSETS / f"{name}.png", dpi=144, facecolor="white",
                metadata={"Software": "ResearchAgent evidence renderer"})
    if svg:
        fig.savefig(ASSETS / f"{name}.svg", facecolor="white",
                    metadata={"Date": None, "Creator": "ResearchAgent evidence renderer"})
        svg_path = ASSETS / f"{name}.svg"
        svg_text = svg_path.read_text(encoding="utf-8")
        svg_path.write_text("\n".join(line.rstrip() for line in svg_text.splitlines()) + "\n", encoding="utf-8", newline="\n")
    plt.close(fig)


def workflow():
    fig, ax = plt.subplots(figsize=(14.4, 5.5))
    ax.set(xlim=(0, 1), ylim=(0, 1)); ax.axis("off")
    fig.subplots_adjust(left=.015, right=.985, top=.98, bottom=.04)
    ax.text(.025, .945, "ResearchAgent", fontsize=27, weight="bold", va="top")
    ax.text(.025, .837, "Scientific strategy on a real multi-turn coding-agent loop", fontsize=17)
    cards = [
        (.025, "Research task", "paper / data / objective", "Understand the task"),
        (.275, "Scientific strategy", "intent + relevant methods", "Context guidance"),
        (.525, "Model + tools", "read / write / edit / shell", "Execute, observe, revise"),
        (.775, "Scientific outputs", "code / predictions / metrics", "Inspect actual results"),
    ]
    for x, title, body, footer in cards:
        box = FancyBboxPatch((x, .385), .20, .29,
            boxstyle="round,pad=0.012,rounding_size=0.018", linewidth=1.4,
            edgecolor=BORDER, facecolor=LIGHT if x != .525 else "#E9F5F5")
        ax.add_patch(box)
        ax.text(x+.10, .605, title, fontsize=16, weight="bold", ha="center")
        ax.text(x+.10, .515, body, fontsize=12.4, ha="center")
        ax.text(x+.10, .435, footer, fontsize=11.5, ha="center", color=GREY)
    for x in [.225, .475, .725]:
        ax.add_patch(FancyArrowPatch((x+.005, .53), (x+.041, .53),
            arrowstyle="-|>", mutation_scale=18, color=TEAL, linewidth=1.8))
    ax.text(.375, .725, "Capability catalog / optional Skills & MCP", fontsize=11.4,
            ha="center", color=GREY)
    ax.add_patch(FancyArrowPatch((.375, .713), (.375, .689), arrowstyle="-|>",
                                color=GREY, mutation_scale=13))
    ax.add_patch(FancyArrowPatch((.875, .369), (.625, .369),
        connectionstyle="arc3,rad=-0.20", arrowstyle="-|>",
        mutation_scale=17, color=TEAL, linewidth=1.8))
    ax.text(.75, .239, "Numerical feedback informs the next action", fontsize=12,
            ha="center", color=TEAL)
    ax.text(.025, .172, "Analyze  →  define metrics  →  implement candidates  →  run experiments  →  revise", fontsize=14.0,
            weight="bold")
    ax.text(.025, .074, "Architecture / method map, not an execution trace. Steps are task-dependent, not mandatory.",
            fontsize=11.5, color=GREY)
    save(fig, "research-workflow", svg=True)


def paperbench(data):
    papers = data["papers"]
    assert len(papers) == data["paperCount"] == data["scoredPaperCount"] == 20
    assert [p["order"] for p in papers] == list(range(1, 21))
    mean = sum(p["scorePercent"] for p in papers) / len(papers)
    assert math.isclose(mean, data["meanScorePercent"], abs_tol=1e-10)
    fig, ax = plt.subplots(figsize=(14.4, 12.3))
    fig.subplots_adjust(left=.325, right=.945, top=.842, bottom=.112)
    fig.text(.037, .965, "PaperBench Code-Dev · all 20 papers", fontsize=25,
             weight="bold", va="top")
    fig.text(.037, .917, "One Agent attempt per paper · original registered order · all scores retained", fontsize=14,
             color=GREY)
    fig.text(.037, .878, "Custom DeepSeek Judge. Not full paper reproduction, and not an official leaderboard comparison.",
             fontsize=12.2, color=GREY)
    y = list(range(20)); scores = [p["scorePercent"] for p in papers]
    ax.barh(y, scores, height=.62, color=TEAL, alpha=.94, zorder=3)
    ax.set_yticks(y, [f"{p['order']:02d}  {p['paperId']}" for p in papers], fontsize=13)
    ax.invert_yaxis(); ax.set_xlim(0, 108)
    ax.set_xticks(range(0, 101, 20)); ax.xaxis.set_major_formatter(PercentFormatter(100))
    ax.tick_params(axis="y", length=0, pad=12)
    ax.grid(axis="x", color=BORDER, linewidth=.7, zorder=0)
    ax.set_xlabel("Rubric-weighted code implementation score per paper", labelpad=12, fontsize=14)
    ax.axvline(mean, color=ORANGE, linestyle=(0, (5, 4)), linewidth=2,
               label=f"Equal-paper mean: {mean:.2f}%", zorder=4)
    for i, value in enumerate(scores):
        ax.text(value+1.0, i, f"{value:.2f}%", va="center", fontsize=12.5, weight="bold",
                bbox={"facecolor": "white", "edgecolor": "none", "pad": .6})
    fig.legend(*ax.get_legend_handles_labels(), loc="lower left",
               bbox_to_anchor=(.033, .037), frameon=False, fontsize=14)
    fig.text(.037, .022, "Score = mean of 20 paper-wise weighted scores, not passed rubric nodes / all nodes. Completed 2026-10-09.",
             fontsize=11.6, color=GREY)
    save(fig, "paperbench-code-dev-all20")


def candidate_label(candidate, kind):
    if candidate.startswith("RIDGE_"):
        return "Ridge  α=" + candidate.split("_A")[1]
    if candidate.startswith("LOGISTIC_"):
        return "Logistic  C=" + candidate.split("_C")[1]
    if candidate.startswith("KRR_"):
        a, g = candidate.split("_A")[1].split("_G")
        return f"RBF KRR  α={a}, γ={g}"
    c, g = candidate.split("_C")[1].split("_G")
    return f"RBF SVC  C={c}, γ={g}"


def science(data):
    tasks = data["tasks"]
    assert len(tasks) == 2
    assert data["scientificProcedureAndNumericVerifiedCount"] == 2
    assert data["independentReplayCorrectCount"] == 2
    assert data["originalRegisteredCompleteCount"] == 1
    fig, axes = plt.subplots(1, 2, figsize=(16.5, 10.4))
    fig.subplots_adjust(left=.177, right=.962, top=.733, bottom=.342, wspace=.84)
    fig.text(.033, .956, "Recorded scientific experiments, not just generated answers", fontsize=24, weight="bold")
    fig.text(.033, .910, "ResearchAgent + deepseek-flash · all declared candidates · validation-only selection", fontsize=14.2,
             color=GREY)
    handles = [Patch(color=NAVY, label="Linear family"), Patch(color=TEAL, label="RBF family"),
               Patch(color=ORANGE, label="Validation-selected candidate")]
    fig.legend(handles=handles, loc="upper left", bbox_to_anchor=(.026, .870),
               ncol=3, frameon=False, fontsize=12)
    for i, (ax, task) in enumerate(zip(axes, tasks)):
        m = task["metrics"]; rows = m["validation_results"]
        assert len(rows) == task["candidateCount"]
        key = "validation_rmse" if task["kind"] == "regression" else "validation_balanced_accuracy"
        values = [r[key] for r in rows]
        chosen = (min if task["kind"] == "regression" else max)(range(len(rows)), key=lambda j: values[j])
        assert rows[chosen]["candidate_id"] == m["selected_candidate"]
        colors = [ORANGE if r["candidate_id"] == m["selected_candidate"] else
                  (NAVY if r["candidate_id"].startswith(("RIDGE", "LOGISTIC")) else TEAL) for r in rows]
        y = list(range(len(rows)))
        ax.barh(y, values, height=.62, color=colors, zorder=3)
        ax.set_yticks(y, [candidate_label(r["candidate_id"], task["kind"]) for r in rows], fontsize=12)
        ax.invert_yaxis(); ax.tick_params(axis="y", length=0, pad=8)
        ax.grid(axis="x", color=BORDER, zorder=0)
        if task["kind"] == "regression":
            ax.set_xlim(0, max(values)*1.20)
            ax.set_xlabel("Validation RMSE · lower is better", fontsize=12.4, labelpad=10)
            ax.set_title("Abalone · 7 candidate fits", fontsize=15, weight="bold", pad=18)
            fmt = lambda v: f"{v:.4f}"
        else:
            ax.set_xlim(0, 1.18)
            ax.xaxis.set_major_formatter(PercentFormatter(1))
            ax.set_xlabel("Validation balanced accuracy", fontsize=12.4, labelpad=10)
            ax.set_title("Ionosphere · 9 candidate fits", fontsize=15, weight="bold", pad=18)
            fmt = lambda v: f"{v*100:.2f}%"
        for j, v in enumerate(values):
            ax.text(v + ax.get_xlim()[1]*.019, j, fmt(v), fontsize=10.9, va="center")
    box_y, box_h = .118, .145
    for x in [.032, .514]:
        fig.add_artist(FancyBboxPatch((x, box_y), .45, box_h,
            boxstyle="round,pad=0.013,rounding_size=0.01", transform=fig.transFigure,
            facecolor=LIGHT, edgecolor=BORDER))
    reg, clf = tasks; rm, cm = reg["metrics"], clf["metrics"]
    fig.text(.048, .244, f"Abalone · held-out test n={rm['n_eval']}", fontsize=14.6, weight="bold")
    fig.text(.048, .211, f"RMSE {rm['test_rmse']:.4f}   |   MAE {rm['test_mae']:.4f}", fontsize=16.5, weight="bold", color=TEAL)
    fig.text(.048, .176, f"{reg['physicalModelCalls']} model calls · {reg['wallSeconds']:.2f}s · numerical replay matched", fontsize=12)
    fig.text(.048, .141, "Original registered package verdict: PASS", fontsize=11.8, color=GREY)
    fig.text(.530, .244, f"Ionosphere · held-out test n={cm['n_eval']}", fontsize=14.6, weight="bold")
    fig.text(.530, .211, f"Accuracy {cm['test_accuracy']*100:.2f}%   |   balanced {cm['test_balanced_accuracy']*100:.2f}%", fontsize=15.8,
             weight="bold", color=TEAL)
    fig.text(.530, .176, f"{clf['physicalModelCalls']} model calls · {clf['wallSeconds']:.2f}s · numerical replay matched", fontsize=12)
    fig.text(.530, .141, "Original package verdict: FAIL (report-location rule)", fontsize=11.8, color=ORANGE)
    fig.text(.033, .074, "Scientific/numerical checks: 2/2. Original package acceptance: 1/2; its report-location limitation is preserved.",
             fontsize=11.8, color=GREY)
    fig.text(.033, .034, "Two predefined tasks, one fixed split each. No SOTA, general success-rate, strategy-causal or training-gain claim.",
             fontsize=11.8, color=GREY)
    save(fig, "scientific-execution-candidates")


def main():
    ASSETS.mkdir(parents=True, exist_ok=True)
    style()
    workflow()
    paperbench(load("docs/evaluation/paperbench-code-dev-all20-summary.json"))
    science(load("docs/evaluation/d1-scientific-execution-summary.json"))
    print("Rendered existing-evidence figures; 0 model calls / 0 new benchmark runs.")
    for p in sorted(ASSETS.iterdir()):
        print(p.name, p.stat().st_size)


if __name__ == "__main__":
    main()
