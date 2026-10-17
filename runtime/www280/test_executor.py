import json
import tempfile
import unittest
from pathlib import Path

import executor as ex


def ready_h15():
    cells = [
        {
            "run_id": ex.run_id(2, "vite_h1", 3, 1),
            "valid": True,
            "n": 2,
            "hop": "vite_h1",
            "slots": 3,
            "phase": "DONE",
            "terminal_invalid": False,
        }
    ]
    h14 = {"closed": True, "next_branches": ["H15", "H16", "H17", "H18"], "terminates_campaign": False}
    h15 = ex.h15_queue(cells, h14)
    budget = {
        "operational_remaining_via_existing_runner": 27,
        "diagnostic_used": 0,
        "diagnostic_remaining": 40,
    }
    volumes = {"C3": [{"letter": "E", "free_gb": 20}], "C4": [{"letter": "E", "free_gb": 20}]}
    return h14, h15, budget, volumes


class ExecutorTests(unittest.TestCase):
    def test_old_final_decision_does_not_block_new_epoch(self):
        h14, h15, budget, volumes = ready_h15()
        decision = ex.decide(
            old_final_decision="SCIENTIFIC_NO_GO",
            same_epoch_terminal=False,
            active=None,
            h14=h14,
            h15=h15,
            budget_info=budget,
            controller_free_gb=80,
            worker_volumes=volumes,
            render_visible=None,
            instrument_valid=False,
            frozen_exists=False,
            qualifications={"amendment_a_retired_fixed_288": True},
        )
        self.assertEqual(decision.state, "NEW_EPOCH_READY")
        self.assertTrue(decision.launch)
        self.assertIn("viteh1_s1_r1", decision.command[2])

    def test_same_epoch_terminal_cannot_be_bypassed(self):
        h14, h15, budget, volumes = ready_h15()
        decision = ex.decide(
            old_final_decision="SCIENTIFIC_NO_GO",
            same_epoch_terminal=True,
            active=None,
            h14=h14,
            h15=h15,
            budget_info=budget,
            controller_free_gb=80,
            worker_volumes=volumes,
            render_visible=None,
            instrument_valid=False,
            frozen_exists=False,
            qualifications={"amendment_a_retired_fixed_288": True},
        )
        self.assertFalse(decision.launch)
        self.assertEqual(decision.first_blocker["id"], "BLOCKED_SCIENTIFIC_PREREQUISITE")

    def test_active_cell_prevents_second_executor(self):
        h14, h15, budget, volumes = ready_h15()
        decision = ex.decide(
            old_final_decision="SCIENTIFIC_NO_GO",
            same_epoch_terminal=False,
            active={"run_id": "radh2_s3_r5", "phase": "READY", "live_pids": [10], "ambiguous": False},
            h14=h14,
            h15=h15,
            budget_info=budget,
            controller_free_gb=80,
            worker_volumes=volumes,
            render_visible=None,
            instrument_valid=False,
            frozen_exists=False,
            qualifications={"amendment_a_retired_fixed_288": True},
        )
        self.assertEqual(decision.state, "WAIT_ACTIVE_CELL")
        self.assertFalse(decision.launch)

    def test_stale_lock_requires_proof(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "exclusive_executor.json"
            lock = ex.ExclusiveLock(path, pid_probe=lambda pid: True)
            ex.write_json(path, {"held": True, "pid": 321, "start_identity": "321|start"})
            refused = lock.acquire("www280", "test")
            self.assertFalse(refused.acquired)
            self.assertFalse(list(Path(tmp).glob("exclusive_executor.archived.*.json")))

            lock = ex.ExclusiveLock(path, pid_probe=lambda pid: False)
            ex.write_json(path, {"held": True, "pid": 321, "start_identity": ""})
            no_identity = lock.acquire("www280", "test", active_worker=False)
            self.assertFalse(no_identity.acquired)

            ex.write_json(path, {"held": True, "pid": 321, "start_identity": "321|start"})
            busy = lock.acquire("www280", "test", active_worker=True)
            self.assertFalse(busy.acquired)

            proved = lock.acquire("www280", "test", active_worker=False)
            self.assertTrue(proved.acquired)
            self.assertTrue(proved.archived)
            self.assertTrue(list(Path(tmp).glob("exclusive_executor.archived.*.json")))

    def test_valid_completed_run_is_reused(self):
        h14, h15, _, _ = ready_h15()
        credited = [row for row in h15 if row["slots"] == 3][0]
        self.assertEqual(credited["status"], "REUSED_VALID")
        self.assertTrue(credited["credited_run_id"].endswith("viteh1_s3_r1"))
        queued = [row for row in h15 if row["slots"] == 1][0]
        self.assertEqual(queued["status"], "NEEDS_EXECUTION")
        self.assertFalse(h14["terminates_campaign"])
        self.assertIn("H16", h14["next_branches"])
        self.assertIn("H18", h14["next_branches"])

    def test_null_render_visible_splits_transport_and_visual(self):
        self.assertTrue(ex.visual_claim_allowed(None, False, "transport"))
        self.assertFalse(ex.visual_claim_allowed(None, False, "visual"))

    def test_budget_cannot_reset_through_a_new_command(self):
        previous = {"diagnostic_used": 5, "diagnostic_remaining": 35, "diagnostic_cap": 40}
        continued = ex.continue_budget(previous, "COMMAND281")
        self.assertEqual(continued["diagnostic_used"], 5)
        self.assertEqual(continued["diagnostic_remaining"], 35)
        self.assertFalse(continued["reset"])

    def test_fixed_288_cannot_launch_before_qualification(self):
        allowed, reason = ex.confirmatory_allowed(True, {"amendment_a_retired_fixed_288": True})
        self.assertFalse(allowed)
        self.assertIn("PREREQUISITE", reason)
        retired, retired_reason = ex.confirmatory_allowed(False, {"amendment_a_retired_fixed_288": False})
        self.assertFalse(retired)
        self.assertEqual(retired_reason, "AMENDMENT_A_RETIRED_FIXED_288")

    def test_missing_f_blocks_only_the_physical_launch(self):
        h14, h15, budget, volumes = ready_h15()
        decision = ex.decide(
            old_final_decision="SCIENTIFIC_NO_GO",
            same_epoch_terminal=False,
            active=None,
            h14=h14,
            h15=h15,
            budget_info=budget,
            controller_free_gb=None,
            worker_volumes=volumes,
            render_visible=None,
            instrument_valid=False,
            frozen_exists=False,
            qualifications={"amendment_a_retired_fixed_288": True},
        )
        self.assertFalse(decision.launch)
        self.assertEqual(decision.state, "BLOCKED_INFRA")
        self.assertIsNotNone(decision.next_cell)
        self.assertTrue(decision.command)

    def test_invalid_attempt_is_counted_once(self):
        first = ex.record_attempt({"executions": 17, "attempts": []}, "cell-a")
        second = ex.record_attempt(first, "cell-a")
        self.assertEqual(first["executions"], 18)
        self.assertTrue(second["duplicate"])
        self.assertEqual(second["executions"], 18)

    def test_completed_cell_manifest_points_at_existing_evidence(self):
        with tempfile.TemporaryDirectory() as tmp:
            evidence = Path(tmp) / "evidence" / "cell-a"
            evidence.mkdir(parents=True)
            rows = ex.manifest_rows(
                [
                    {
                        "run_id": "cell-a",
                        "phase": "DONE",
                        "valid": True,
                        "evidence": str(evidence),
                    }
                ]
            )
            self.assertEqual(rows[0]["promotion"], "REUSED_EXISTING")
            self.assertTrue(rows[0]["evidence_exists"])

    def test_run_next_does_not_call_launcher_when_blocked(self):
        h14, h15, budget, _ = ready_h15()
        decision = ex.decide(
            old_final_decision="SCIENTIFIC_NO_GO",
            same_epoch_terminal=False,
            active=None,
            h14=h14,
            h15=h15,
            budget_info=budget,
            controller_free_gb=80,
            worker_volumes={"C3": [{"letter": "D", "free_gb": 100}]},
            render_visible=None,
            instrument_valid=False,
            frozen_exists=False,
            qualifications={"amendment_a_retired_fixed_288": True},
        )
        called = []
        result = ex.run_next(decision, called.append)
        self.assertFalse(result["launched"])
        self.assertEqual(called, [])
        self.assertEqual(result["blocker"]["id"], "BLOCKED_INFRA_WORKER_STORAGE")

    def test_done_cell_is_not_an_active_owner(self):
        cells = [
            {
                "run_id": "nsdi_N2_LRU_coit-40m-sh1-lod_stop_go_g1_radh2_s3_r5",
                "phase": "DONE",
                "pids": [97492],
                "valid": True,
            }
        ]
        self.assertIsNone(ex.active_cell(cells, pid_probe=lambda pid: False))


def write_selftest_report(result: unittest.result.TestResult) -> None:
    payload = {
        "passed": result.wasSuccessful(),
        "tests": result.testsRun,
        "failures": [str(item[0]) for item in result.failures],
        "errors": [str(item[0]) for item in result.errors],
    }
    path = Path(r"F:\WWW_N3_MUX\audits\EXECUTOR_SELFTEST_RESULTS.json")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    outcome = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(ExecutorTests))
    write_selftest_report(outcome)
    raise SystemExit(0 if outcome.wasSuccessful() else 1)
