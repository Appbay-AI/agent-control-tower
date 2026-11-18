"""The Sanctions Pre-screener (AGT-0003), as a LangGraph agent. It is level 1 (Observe): it may screen and recommend,
never act. The demo shows it trying to release a held payment anyway, the Control Tower refusing by policy, and the
agent handing the case to a person instead.

    python screening_agent.py              Screen Ardent Trading FZE, then try to release the held USD 86,000 payment.
    python screening_agent.py --test       The same, marked as a test.
"""
from __future__ import annotations

import argparse
import sys
import time
from datetime import datetime, timezone
from typing import Optional, TypedDict

from langgraph.graph import END, START, StateGraph

from act import ControlTower, Refused, from_env
from show import banner, money, say


class Case(TypedDict, total=False):
    counterparty: str
    payment: str
    amount: float
    currency: str
    test: bool
    run: str
    finding: str
    status: str   # screened | refused | released | stopped
    why: str
    request_code: str


def build(ct: ControlTower, sleep=time.sleep):
    def check_in(c: Case) -> Case:
        try:
            s = ct.status()
        except Refused as e:
            return {"status": "stopped", "why": str(e)}
        say("agent", f"{s['agent_code']} is {s['status']} (autonomy level {s['autonomy_level']}: observe and recommend).")
        return {}

    def screen(c: Case) -> Case:
        say("agent", f"Screening {c['counterparty']} against the consolidated sanctions lists…")
        sleep(0.6)
        finding = "No exact match; two partial name matches, both with a different country and date of incorporation."
        say("agent", finding)
        ct.log(f"Screened {c['counterparty']}: {finding}", event="screening.done", details={"counterparty": c["counterparty"]})
        return {"finding": finding, "status": "screened"}

    def try_release(c: Case) -> Case:
        say("agent", f"The payment {c['payment']} ({money(c['amount'], c['currency'])}) has been held for four hours. "
                     "Releasing it myself would be quicker…")
        say("ask", "Asking the Control Tower first…")
        details = {"counterparty": c["counterparty"], "payment": c["payment"]}
        if c.get("test"):
            details["test"] = True
        try:
            r = ct.ask({"idempotency_key": f"release-{c['payment']}-{c['run']}", "action": "payment.release",
                        "description": f"Release the held payment {c['payment']} to {c['counterparty']} after screening",
                        "reasoning": c["finding"], "amount": c["amount"], "currency": c["currency"],
                        "target_system": "SWIFT gateway", "details": details})
        except Refused as e:
            return {"status": "stopped", "why": str(e)}
        say("ok" if r["may_proceed"] else "stop", f"{r['request_code']}: {r['status']}. {r.get('reason') or ''}".strip())
        return {"status": "released" if r["may_proceed"] else "refused", "why": r.get("reason") or "", "request_code": r["request_code"]}

    def hand_over(c: Case) -> Case:
        say("agent", "Understood: I may only recommend. Handing the case to a payments officer with my recommendation to release.")
        ct.log(f"Refused by the Control Tower ({c.get('request_code')}); case handed to a payments officer with a recommendation to release",
               level="warning", event="handover", request=c.get("request_code"))
        say("done", "Case handed over. The payment stays held until a person releases it.")
        return {}

    def stopped(c: Case) -> Case:
        say("stop", c.get("why") or "The Control Tower said no.")
        return {}

    g = StateGraph(Case)
    for name, fn in [("check_in", check_in), ("screen", screen), ("try_release", try_release), ("hand_over", hand_over), ("stopped", stopped)]:
        g.add_node(name, fn)
    g.add_edge(START, "check_in")
    g.add_conditional_edges("check_in", lambda c: "stopped" if c.get("status") == "stopped" else "screen")
    g.add_edge("screen", "try_release")
    g.add_conditional_edges("try_release", lambda c: {"refused": "hand_over", "stopped": "stopped"}.get(c.get("status"), END))
    g.add_edge("hand_over", END)
    g.add_edge("stopped", END)
    return g.compile()


def main(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="The Sanctions Pre-screener demo agent.")
    ap.add_argument("--test", action="store_true", help="mark the request as a test: nobody is emailed or alerted")
    a = ap.parse_args(argv)
    ct = from_env("SCREENING_AGENT_KEY", "SCREENING_AGENT", "AGT-0003")
    banner("Sanctions Pre-screener", [f"Control Tower: {ct.url}", f"Agent: {ct.agent}"])
    rid = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    out = build(ct).invoke({"counterparty": "Ardent Trading FZE", "payment": f"PAY-{rid[-6:]}", "amount": 86_000, "currency": "USD",
                            "test": a.test, "run": rid})
    return 0 if out.get("status") == "refused" else 2


if __name__ == "__main__":
    sys.exit(main())
