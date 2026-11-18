"""Clear, readable terminal output for the demo: a time, a coloured tag and one sentence per step."""
from __future__ import annotations

import os
import sys
from datetime import datetime

if os.name == "nt":  # lets Windows terminals show the colours
    os.system("")
COLOUR = sys.stdout.isatty() and not os.environ.get("NO_COLOR")
TAGS = {
    "agent": ("36", "AGENT  "),   # cyan: what the agent is doing
    "ask": ("33", "ASK    "),     # yellow: asking the Control Tower
    "wait": ("33", "WAIT   "),
    "ok": ("32", "ALLOWED"),      # green
    "done": ("32", "DONE   "),
    "stop": ("31", "STOPPED"),    # red: the agent will not act
    "info": ("37", "       "),
}


def say(kind: str, text: str) -> None:
    code, tag = TAGS.get(kind, TAGS["info"])
    stamp = datetime.now().strftime("%H:%M:%S")
    if COLOUR:
        print(f"\033[2m{stamp}\033[0m \033[1;{code}m{tag}\033[0m {text}", flush=True)
    else:
        print(f"{stamp} {tag} {text}", flush=True)


def banner(title: str, lines: list[str]) -> None:
    rule = "─" * max(len(title), *(len(x) for x in lines)) if lines else "─" * len(title)
    print(f"\n{rule}\n{title}", flush=True)
    for x in lines:
        print(x, flush=True)
    print(rule, flush=True)


def money(amount: float, currency: str = "GBP") -> str:
    return f"{'£' if currency == 'GBP' else currency + ' '}{amount:,.0f}"


def elapsed(seconds: float) -> str:
    m, s = divmod(int(seconds), 60)
    return f"{m}:{s:02d}"
