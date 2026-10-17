"""Ordinary incremental draw-index update. Not a SPADE admission policy.

When the view token is unchanged, testing only arrived and evicted chunks
must select the same chunks as walking every resident chunk. A changed view
invalidates that shortcut.
"""


def select(chunks, view):
    return sorted(chunk for chunk in chunks if chunk % 17 != view % 17)


def full_rebuild(resident, view):
    return select(resident, view), len(resident)


def incremental(previous, arrived, evicted, view, previous_view):
    if view != previous_view:
        return None
    kept = [chunk for chunk in previous if chunk not in evicted]
    added = select(arrived, view)
    return sorted(set(kept + added)), len(arrived) + len(evicted)


def main() -> None:
    resident = list(range(1000))
    view = 3
    selected, full_visits = full_rebuild(resident, view)
    arrived = [1000, 1001, 1019]
    evicted = [3, 20]
    updated, delta_visits = incremental(selected, arrived, evicted, view, view)
    again, _ = full_rebuild([chunk for chunk in resident if chunk not in evicted] + arrived, view)
    assert updated == again
    assert delta_visits == 5
    assert full_visits == 1000
    assert incremental(selected, arrived, evicted, view + 1, view) is None
    print("INCREMENTAL_INDEX_OK")


if __name__ == "__main__":
    main()
