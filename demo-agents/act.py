"""A small client for the Agent Control Tower API (docs/agent-api.md), used by the demo agents.

Only the Python standard library, so the demo laptop needs nothing beyond LangGraph. Every call fails closed: if the
Control Tower cannot be reached or says no, the agent is told it may not act.
"""
from __future__ import annotations

import json
import os
import ssl
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path


class Refused(Exception):
    """The Control Tower said no, or could not be reached. The agent must not act."""


def load_env(path: Path | None = None) -> None:
    """Read KEY=value lines from demo-agents/.env into the environment (values already set win)."""
    path = path or Path(__file__).with_name(".env")
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


@dataclass
class ControlTower:
    url: str          # e.g. https://agent-control-tower-56p.pages.dev
    key: str          # the agent's own key, made on its page in the Control Tower
    agent: str        # the agent's code, e.g. AGT-0001
    timeout: float = 15.0

    def _call(self, method: str, path: str, body: dict | None = None, headers: dict | None = None) -> dict:
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.url.rstrip("/") + path, data=data, method=method, headers={
            "Authorization": f"Bearer {self.key}", "Content-Type": "application/json", "Accept": "application/json",
            "User-Agent": "northbridge-demo-agent/1.0", **(headers or {})})
        try:
            with urllib.request.urlopen(req, timeout=self.timeout, context=ssl.create_default_context()) as res:
                return json.loads(res.read() or b"{}")
        except urllib.error.HTTPError as e:
            try:
                detail = json.loads(e.read() or b"{}")
            except ValueError:
                detail = {}
            raise Refused(detail.get("detail") or detail.get("title") or f"The Control Tower answered {e.code}") from None
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            raise Refused(f"Could not reach the Control Tower ({getattr(e, 'reason', e)})") from None

    # Before acting: am I still allowed to act? (The kill switch answers here.)
    def status(self) -> dict:
        s = self._call("GET", f"/api/v1/agents/{self.agent}/status")
        if not s.get("may_act"):
            raise Refused(f"{s.get('agent_code', self.agent)} is {s.get('status', 'not live')}: it may not act")
        return s

    def ask(self, payload: dict) -> dict:
        return self._call("POST", "/api/v1/actions/request", payload)

    def decision(self, request_id: str) -> dict:
        return self._call("GET", f"/api/v1/actions/{request_id}")

    def wait(self, request_id: str, every: float = 2.0, limit: float = 3 * 3600, on_tick=None) -> dict:
        """Ask for the decision every few seconds until a person decides (or the time limit passes)."""
        started = time.monotonic()
        while True:
            d = self.decision(request_id)
            if d.get("status") != "pending":
                return d
            if on_tick:
                on_tick(time.monotonic() - started)
            if time.monotonic() - started > limit:
                raise Refused("No decision in time: the agent must not act")
            time.sleep(every)

    def heartbeat(self, note: str | None = None) -> dict:
        return self._call("POST", f"/api/v1/agents/{self.agent}/heartbeat", {"note": note} if note else {})

    def log(self, message: str, level: str = "info", event: str | None = None, request: str | None = None,
            details: dict | None = None) -> None:
        """Write to the agent's log on its page. Never stops the agent: a log that fails is only reported."""
        entry = {"message": message[:2000], "level": level}
        if event:
            entry["event"] = event
        if request:
            entry["request"] = request
        if details:
            entry["details"] = details
        try:
            self._call("POST", f"/api/v1/agents/{self.agent}/logs", entry)
        except Refused:
            pass

    def report_incident(self, title: str, severity: str, description: str, idempotency_key: str, details: dict | None = None) -> dict:
        return self._call("POST", "/api/v1/incidents", {"title": title, "severity": severity, "description": description,
                                                        "details": details or {}}, {"Idempotency-Key": idempotency_key})


def from_env(key_var: str, agent_var: str, default_agent: str) -> ControlTower:
    load_env()
    url = os.environ.get("ACT_URL", "").strip()
    key = os.environ.get(key_var, "").strip()
    missing = [n for n, v in (("ACT_URL", url), (key_var, key)) if not v]
    if missing:
        raise SystemExit(f"Set {' and '.join(missing)} in demo-agents/.env first (see demo-agents/README.md).")
    return ControlTower(url=url, key=key, agent=os.environ.get(agent_var, default_agent).strip() or default_agent)
