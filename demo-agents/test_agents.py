"""Tests for the demo agents against a stand-in Control Tower (run: python -m unittest discover demo-agents)."""
from __future__ import annotations

import io
import json
import os
import sys
import threading
import unittest
from contextlib import redirect_stdout
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(__file__))
import payment_agent  # noqa: E402
import screening_agent  # noqa: E402


class FakeTower:
    """Follows the real rules closely enough: a £250,000 limit for AGT-0001, observe-only AGT-0003, a kill switch."""

    def __init__(self):
        self.status = {"AGT-0001": "live", "AGT-0003": "live"}
        self.requests: dict[str, dict] = {}
        self.logs: list[dict] = []
        self.decide_after = 2            # polls before a waiting request is decided
        self.decision = "approved"
        self.suspend_after_releases = None
        self.suspend_on_final_check = False
        self.calls: list[str] = []

    def agent_for(self, key: str) -> str:
        return {"key-pay": "AGT-0001", "key-screen": "AGT-0003"}[key]

    def handle(self, method, path, key, body):
        agent = self.agent_for(key)
        self.calls.append(f"{method} {path}")
        if self.status[agent] != "live":
            return 403, {"title": "forbidden", "detail": f"{agent} is suspended: its key is refused"}
        if path.endswith("/status"):
            if self.suspend_on_final_check and any(r["status"] == "approved" for r in self.requests.values()):
                self.status[agent] = "suspended"
                return 403, {"detail": f"{agent} is suspended: its key is refused"}
            return 200, {"agent_code": agent, "status": "live", "may_act": True, "autonomy_level": 3 if agent == "AGT-0001" else 1}
        if path == "/api/v1/actions/request":
            code = f"REQ-{len(self.requests) + 1:06d}"
            if agent == "AGT-0003":
                st, why = "refused", "AGT-0003 is level 1 (Observe): it may read and recommend only, never act."
            elif body["amount"] > 250000:
                st, why = "pending", "AGT-0001 is level 3 and this is outside its limits. A human must approve."
            else:
                st, why = "approved", "AGT-0001 is level 3 and this is within its limits."
            r = {"request_id": code.lower(), "request_code": code, "status": st, "may_proceed": st == "approved", "reason": why,
                 "polls": 0, "body": body}
            self.requests[code.lower()] = r
            return 201, {k: v for k, v in r.items() if k not in ("polls", "body")}
        if path.startswith("/api/v1/actions/"):
            r = self.requests[path.rsplit("/", 1)[1]]
            if r["status"] == "pending":
                r["polls"] += 1
                if r["polls"] >= self.decide_after:
                    r["status"] = self.decision
                    r["may_proceed"] = self.decision == "approved"
                    r["reason"] = "Approved by Ravi Menon and Daniel Okafor" if self.decision == "approved" else "Rejected by Ravi Menon: call the supplier back first"
            return 200, {k: v for k, v in r.items() if k not in ("polls", "body")}
        if path.endswith("/logs"):
            self.logs.append(body)
            if body.get("event") == "payment.released" and self.suspend_after_releases is not None:
                if sum(1 for x in self.logs if x.get("event") == "payment.released") >= self.suspend_after_releases:
                    self.status[agent] = "suspended"   # the kill switch is pulled
            return 201, {"accepted": 1}
        if path.endswith("/heartbeat"):
            return 200, {"status": "live", "may_act": True}
        return 404, {"detail": "no such address"}


def serve(tower: FakeTower):
    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _do(self, method):
            n = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(n) or b"{}") if n else None
            code, out = tower.handle(method, self.path, self.headers["Authorization"].split()[1], body)
            data = json.dumps(out).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            self._do("GET")

        def do_POST(self):
            self._do("POST")

    srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


class DemoAgents(unittest.TestCase):
    def setUp(self):
        self.tower = FakeTower()
        self.srv = serve(self.tower)
        os.environ.update({"ACT_URL": f"http://127.0.0.1:{self.srv.server_port}", "PAYMENT_AGENT_KEY": "key-pay",
                           "SCREENING_AGENT_KEY": "key-screen", "ACT_POLL_SECONDS": "0.01", "NO_COLOR": "1"})

    def tearDown(self):
        self.srv.shutdown()
        self.srv.server_close()

    def run_agent(self, mod, *args):
        out = io.StringIO()
        with redirect_stdout(out):
            code = mod.main(list(args))
        return code, out.getvalue()

    def released(self):
        return [x for x in self.tower.logs if x.get("event") == "payment.released"]

    def test_hartwell_waits_for_people_then_pays(self):
        code, out = self.run_agent(payment_agent, "hartwell", "--test")
        self.assertEqual(code, 0)
        [req] = self.tower.requests.values()
        self.assertEqual((req["body"]["amount"], req["body"]["details"]["test"], req["body"]["details"]["supplier"]), (2_000_000, True, "Hartwell Steel Ltd"))
        self.assertIn("Waiting for a person to decide REQ-000001", out)
        self.assertIn("Released £2,000,000 to Hartwell Steel Ltd", out)
        self.assertEqual(len(self.released()), 1)
        # Checked with the Control Tower before asking and again just before the money moved.
        self.assertEqual(sum(1 for c in self.tower.calls if c.endswith("/status")), 2)

    def test_hartwell_turned_down_pays_nothing(self):
        self.tower.decision = "rejected"
        code, out = self.run_agent(payment_agent, "hartwell")
        self.assertEqual(code, 2)
        self.assertIn("Not paying Hartwell Steel Ltd: REQ-000001 rejected: Rejected by Ravi Menon", out)
        self.assertEqual(self.released(), [])

    def test_kill_switch_after_approval_stops_the_release(self):
        self.tower.suspend_on_final_check = True
        code, out = self.run_agent(payment_agent, "hartwell")
        self.assertEqual(code, 2)
        self.assertIn("suspended", out)
        self.assertEqual(self.released(), [])

    def test_routine_payments_stop_at_the_next_check_after_the_kill_switch(self):
        self.tower.suspend_after_releases = 2
        code, out = self.run_agent(payment_agent, "run", "--every", "0", "--count", "6")
        self.assertEqual(code, 3)
        self.assertEqual(len(self.released()), 2)
        self.assertEqual(len(self.tower.requests), 2)   # it never even asked for the third
        self.assertIn("It will not make any more payments", out)

    def test_fails_closed_when_the_control_tower_cannot_be_reached(self):
        os.environ["ACT_URL"] = "http://127.0.0.1:9"
        code, out = self.run_agent(payment_agent, "pay", "--amount", "1000")
        self.assertEqual(code, 2)
        self.assertIn("Could not reach the Control Tower", out)

    def test_screening_agent_is_refused_and_hands_over(self):
        code, out = self.run_agent(screening_agent, "--test")
        self.assertEqual(code, 0)
        self.assertIn("REQ-000001: refused. AGT-0003 is level 1 (Observe)", out)
        self.assertIn("Case handed over", out)
        self.assertEqual([x.get("event") for x in self.tower.logs], ["screening.done", "handover"])


if __name__ == "__main__":
    unittest.main()
