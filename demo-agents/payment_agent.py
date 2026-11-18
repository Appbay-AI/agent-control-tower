"""The Payment Release Assistant (AGT-0001), as a LangGraph agent that asks the Control Tower before every release.

    python payment_agent.py hartwell       The demo cue: release £2,000,000 to Hartwell Steel Ltd. Above its £250,000
                                           limit, so it waits for a person (Ravi Menon, then a second approver) and pays
                                           only when the Control Tower says it may.
    python payment_agent.py run            Routine work: small supplier payments every few seconds, within its limits.
                                           Pull the kill switch on its page and it stops at its next check.
    python payment_agent.py pay --amount 480000 --supplier "Calder Logistics"

Add --test to mark requests as tests (nobody is emailed or alerted). See README.md for the set-up.
"""
from __future__ import annotations

import argparse
import itertools
import os
import sys
import time
from datetime import date, datetime, timezone
from typing import Callable, Optional, TypedDict

from langgraph.graph import END, START, StateGraph

from act import ControlTower, Refused, from_env
from show import banner, elapsed, money, say


class Payment(TypedDict, total=False):
    invoice: str
    supplier: str
    amount: float
    currency: str
    purchase_order: str
    due: str
    reason: str
    urgency: str
    test: bool
    run: str
    # Filled in as the graph runs
    request_id: str
    request_code: str
    status: str            # approved | pending | refused | released | stopped
    why: str
    swift_ref: str


HARTWELL: Payment = {
    "invoice": "HS-48817", "supplier": "Hartwell Steel Ltd", "amount": 2_000_000, "currency": "GBP",
    "purchase_order": "PO-2026-0912", "urgency": "high",
    "reason": "Invoice HS-48817 for the Q4 steel order is due today. It matches purchase order PO-2026-0912 and the goods "
              "receipt; paying today avoids a 2% late-payment charge (£40,000).",
}

ROUTINE = [  # within the £250,000 limit: the Control Tower lets these through at once
    ("CL-22931", "Calder Logistics", 18_450), ("PP-10442", "Pennine Packaging", 7_320), ("BU-55102", "Brightwater Utilities", 41_980),
    ("OF-30871", "Oakfield Facilities", 12_600), ("MI-77310", "Marlow IT Services", 96_250), ("SF-41208", "Severn Freight", 23_775),
    ("AP-19077", "Ashby Print Group", 4_910), ("KS-60122", "Kestrel Security", 15_400), ("LV-88013", "Lune Valley Foods", 31_060),
]


def build(ct: ControlTower, poll: float = 2.0, sleep: Callable[[float], None] = time.sleep):
    """The agent's steps as a graph. Every path to a release passes two checks with the Control Tower."""

    def check_in(p: Payment) -> Payment:
        try:
            s = ct.status()
        except Refused as e:
            return {"status": "stopped", "why": str(e)}
        say("agent", f"{s['agent_code']} is {s['status']} and may act (autonomy level {s['autonomy_level']}).")
        return {}

    def read_invoice(p: Payment) -> Payment:
        say("agent", f"Invoice {p['invoice']} from {p['supplier']}: {money(p['amount'], p['currency'])}"
                     + (f", due {p['due']}" if p.get('due') else "") + ".")
        if p.get("purchase_order"):
            say("agent", f"It matches purchase order {p['purchase_order']} and the goods receipt.")
        ct.log(f"Invoice {p['invoice']} from {p['supplier']} ready to pay: {money(p['amount'], p['currency'])}",
               event="invoice.matched", details={"invoice": p["invoice"], "supplier": p["supplier"]})
        return {}

    def ask(p: Payment) -> Payment:
        say("ask", f"Asking the Control Tower before releasing {money(p['amount'], p['currency'])} to {p['supplier']}…")
        details = {"supplier": p["supplier"], "invoice": p["invoice"]}
        if p.get("purchase_order"):
            details["purchase_order"] = p["purchase_order"]
        if p.get("test"):
            details["test"] = True
        try:
            r = ct.ask({
                "idempotency_key": f"pay-{p['invoice']}-{p['run']}",
                "action": "payment.release",
                "description": f"Release {money(p['amount'], p['currency'])} to supplier {p['supplier']}",
                "reasoning": p.get("reason") or f"Invoice {p['invoice']} matches its purchase order and goods receipt; due for payment.",
                "amount": p["amount"], "currency": p["currency"], "urgency": p.get("urgency", "normal"),
                "target_system": "SWIFT gateway", "details": details,
            })
        except Refused as e:
            return {"status": "stopped", "why": str(e)}
        say("ok" if r["status"] == "approved" else "stop" if r["status"] == "refused" else "wait",
            f"{r['request_code']}: {r['status']}. {r.get('reason') or ''}".strip())
        return {"request_id": r["request_id"], "request_code": r["request_code"], "status": r["status"],
                "why": r.get("reason") or ""}

    def wait(p: Payment) -> Payment:
        say("wait", f"Waiting for a person to decide {p['request_code']}. Nothing is paid until they do.")
        ct.log(f"Above my limit; asked for approval and waiting ({p['request_code']})", level="warning",
               event="approval.requested", request=p["request_code"])
        ticks = itertools.count(1)

        def tick(seconds: float) -> None:
            n = next(ticks)
            if n % max(1, round(15 / poll)) == 0:
                say("wait", f"Still waiting ({elapsed(seconds)})…")

        try:
            d = ct.wait(p["request_id"], every=poll, on_tick=tick)
        except Refused as e:
            return {"status": "stopped", "why": str(e)}
        if not d.get("may_proceed"):
            return {"status": "stopped", "why": f"{p['request_code']} {d['status']}: {d.get('reason') or 'not allowed'}"}
        say("ok", f"{p['request_code']} approved: {d.get('reason') or ''}".strip())
        return {"status": "approved", "why": d.get("reason") or ""}

    def final_check(p: Payment) -> Payment:
        # The decision may be old by now: check again, just before the money moves (the kill switch may have been pulled).
        try:
            ct.status()
            d = ct.decision(p["request_id"])
        except Refused as e:
            return {"status": "stopped", "why": str(e)}
        if not d.get("may_proceed"):
            return {"status": "stopped", "why": d.get("reason") or "The Control Tower no longer allows it"}
        return {}

    def release(p: Payment) -> Payment:
        ref = f"NBK{datetime.now(timezone.utc):%y%m%d%H%M%S}"
        sleep(0.4)  # the (simulated) SWIFT gateway
        say("done", f"Released {money(p['amount'], p['currency'])} to {p['supplier']} through the SWIFT gateway "
                    f"(simulated, reference {ref}).")
        ct.log(f"Released {money(p['amount'], p['currency'])} to {p['supplier']} (SWIFT {ref})", event="payment.released",
               request=p.get("request_code"), details={"swift_reference": ref, "simulated": True})
        return {"status": "released", "swift_ref": ref}

    def stopped(p: Payment) -> Payment:
        say("stop", f"Not paying {p.get('supplier', 'this supplier')}: {p.get('why') or 'the Control Tower said no'}.")
        ct.log(f"Did not release the payment to {p.get('supplier')}: {p.get('why')}", level="warning", event="payment.not_released",
               request=p.get("request_code"))
        return {"status": "stopped"}

    g = StateGraph(Payment)
    for name, fn in [("check_in", check_in), ("read_invoice", read_invoice), ("ask", ask), ("wait", wait),
                     ("final_check", final_check), ("release", release), ("stopped", stopped)]:
        g.add_node(name, fn)
    g.add_edge(START, "check_in")
    g.add_conditional_edges("check_in", lambda p: "stopped" if p.get("status") == "stopped" else "read_invoice")
    g.add_edge("read_invoice", "ask")
    g.add_conditional_edges("ask", lambda p: {"approved": "final_check", "pending": "wait"}.get(p.get("status"), "stopped"))
    g.add_conditional_edges("wait", lambda p: "final_check" if p.get("status") == "approved" else "stopped")
    g.add_conditional_edges("final_check", lambda p: "stopped" if p.get("status") == "stopped" else "release")
    g.add_edge("release", END)
    g.add_edge("stopped", END)
    return g.compile()


def run_id() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")


def main(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="The Payment Release Assistant demo agent.")
    ap.add_argument("cue", choices=["hartwell", "run", "pay"], help="hartwell: the £2m story; run: routine payments; pay: one payment")
    ap.add_argument("--amount", type=float, help="for pay: the amount in GBP")
    ap.add_argument("--supplier", default="Calder Logistics", help="for pay: the supplier")
    ap.add_argument("--every", type=float, default=6.0, help="for run: seconds between payments (default 6)")
    ap.add_argument("--count", type=int, default=0, help="for run: stop after this many payments (default: keep going)")
    ap.add_argument("--test", action="store_true", help="mark requests as tests: nobody is emailed or alerted")
    a = ap.parse_args(argv)

    ct = from_env("PAYMENT_AGENT_KEY", "PAYMENT_AGENT", "AGT-0001")
    agent = build(ct, poll=float(os.environ.get("ACT_POLL_SECONDS", "2")))
    rid = run_id()

    if a.cue in ("hartwell", "pay"):
        if a.cue == "pay" and not a.amount:
            ap.error("pay needs --amount")
        p: Payment = dict(HARTWELL) if a.cue == "hartwell" else {
            "invoice": f"INV-{rid[-6:]}", "supplier": a.supplier, "amount": a.amount, "currency": "GBP", "urgency": "normal"}
        p.update({"due": date.today().strftime("%d %b %Y"), "test": a.test, "run": rid})
        banner("Payment Release Assistant", [f"Control Tower: {ct.url}", f"Agent: {ct.agent}" + ("   (test: nobody is alerted)" if a.test else "")])
        out = agent.invoke(p)
        return 0 if out.get("status") == "released" else 2

    banner("Payment Release Assistant: routine payments", [f"Control Tower: {ct.url}", f"Agent: {ct.agent}",
           "Pull the kill switch on its page: it stops at its next check.", "Press Ctrl+C to stop it yourself."])
    last_beat = 0.0
    try:
        for n, (inv, supplier, amount) in enumerate(itertools.cycle(ROUTINE), start=1):
            if time.monotonic() - last_beat > 60:
                try:
                    ct.heartbeat(f"Routine payments: {n - 1} so far")
                except Refused:
                    pass
                last_beat = time.monotonic()
            out = agent.invoke({"invoice": f"{inv}-{rid[-4:]}{n}", "supplier": supplier, "amount": amount, "currency": "GBP",
                                "test": a.test, "run": rid})
            if out.get("status") != "released":
                say("stop", "The agent has stopped. It will not make any more payments.")
                return 3
            if a.count and n >= a.count:
                return 0
            time.sleep(a.every)
    except KeyboardInterrupt:
        print()
        say("info", "Stopped by you (Ctrl+C).")
        return 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
