"""Deterministic gate between a model proposal and any physical cell."""

from __future__ import annotations

import json
from pathlib import Path

ALLOWED = {
    "OFFLINE_ANALYSIS",
    "IMPLEMENTATION_TEST",
    "DEVELOPMENT_PHYSICAL_CELL",
    "FREEZE_REVIEW",
    "WRITING",
    "AUTH_REQUIRED",
    "SAFETY_BLOCKED",
}
REQUIRED = (
    "hypothesis_id",
    "supporting_runs",
    "scientific_question",
    "competing_explanation",
    "proposed_action_type",
    "contract",
    "falsifier",
    "budget",
    "duplicate_lookup",
    "safety_gate",
)
BLOCKED_MECHANISMS = (
    "spade-serial-admit-1",
    "spade-header-release-1",
    "adaptive_second_header",
    "fixed_slots_1",
    "fixed_slots_2",
    "fixed_slots_3",
    "spaDE_v2",
    "SPADE_V2",
    "header-release",
    "header_release",
)


def extract_json(raw: str) -> dict:
    start = raw.find("{")
    end = raw.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("model output has no JSON object")
    return json.loads(raw[start : end + 1])


def validate(proposal: dict, executions: int = 33) -> dict:
    missing = [key for key in REQUIRED if key not in proposal]
    if missing:
        return _reject(proposal, "missing keys: " + ",".join(missing))
    action = proposal.get("proposed_action_type")
    if action not in ALLOWED:
        return _reject(proposal, "unknown action")
    budget = proposal.get("budget") or {}
    if budget.get("executions") != executions or budget.get("cap") != 44:
        return _reject(proposal, "budget does not match the live ledger")
    if action != "DEVELOPMENT_PHYSICAL_CELL":
        return _accept(proposal, physical=False, reason="nonphysical action")
    text = json.dumps(proposal, ensure_ascii=False)
    for name in BLOCKED_MECHANISMS:
        if name.lower() in text.lower():
            return _reject(proposal, "mechanism is already measured or fixture-equivalent: " + name)
    if not proposal.get("offline_fixture_gap"):
        return _reject(proposal, "no offline fixture shows a gap larger than slots=2")
    return _reject(proposal, "physical dispatch is closed until a named fixture file exists")


def _accept(proposal: dict, physical: bool, reason: str) -> dict:
    return {
        "accepted": True,
        "physical": physical,
        "reason": reason,
        "proposal": proposal,
    }


def _reject(proposal: dict, reason: str) -> dict:
    return {
        "accepted": False,
        "physical": False,
        "reason": reason,
        "proposal": proposal,
        "fallback_action_type": "OFFLINE_ANALYSIS",
    }


def load_executions(root: Path) -> int:
    data = json.loads((root / "execution_count.json").read_text(encoding="utf-8"))
    return int(data["executions"])
