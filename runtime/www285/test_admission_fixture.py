"""Offline fixture for always-ready Range admission.

Header service is 165 ms and the body after the first byte is 30 ms.
Infinite demand over 70 s. A second header slot that opens after 80 ms
of wait matches fixed slots=2, because every request already waits longer
than 80 ms. Header-release keeps only one headers-pending request, so its
completion count stays near slots=1.
"""

from __future__ import annotations

HEADER_MS = 165.0
BODY_MS = 30.0
HORIZON_MS = 70000.0


def run(policy: str) -> int:
    now = 0.0
    completed = 0
    headers = []  # start times still waiting for the first byte
    bodies = []  # times when those bodies finish
    while now < HORIZON_MS:
        headers = [start for start in headers if start + HEADER_MS > now]
        bodies = [done for done in bodies if done > now]
        admit = False
        if policy == "slots1":
            admit = len(headers) + len(bodies) < 1
        elif policy == "slots2":
            admit = len(headers) + len(bodies) < 2
        elif policy == "slots3":
            admit = len(headers) + len(bodies) < 3
        elif policy == "header_release":
            admit = len(headers) < 1 and len(headers) + len(bodies) < 2
        elif policy == "adaptive_second_header":
            occupied = len(headers) + len(bodies)
            oldest = min((now - start for start in headers), default=80.0)
            admit = occupied < 2 and (len(headers) == 0 or oldest >= 80.0)
        else:
            raise AssertionError(policy)
        if admit:
            headers.append(now)
            continue
        upcoming = [start + HEADER_MS for start in headers] + bodies
        if policy == "adaptive_second_header" and len(headers) == 1:
            upcoming.append(headers[0] + 80.0)
        upcoming = [moment for moment in upcoming if moment > now]
        if not upcoming:
            break
        nxt = min(upcoming)
        for start in list(headers):
            if start + HEADER_MS <= nxt:
                headers.remove(start)
                bodies.append(start + HEADER_MS + BODY_MS)
        for done in list(bodies):
            if done <= nxt:
                bodies.remove(done)
                completed += 1
        now = nxt
    return completed


def main() -> None:
    counts = {
        name: run(name)
        for name in ("slots1", "slots2", "slots3", "header_release", "adaptive_second_header")
    }
    print(counts)
    assert counts["slots2"] > counts["slots1"]
    assert counts["slots1"] < counts["header_release"] < counts["slots2"]
    assert abs(counts["adaptive_second_header"] - counts["slots2"]) / counts["slots2"] < 0.05
    print("ADMISSION_FIXTURE_OK")


if __name__ == "__main__":
    main()
