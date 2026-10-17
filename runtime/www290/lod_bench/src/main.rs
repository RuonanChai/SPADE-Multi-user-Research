use lod_bench::{build_tree, leaf_ids, traverse, Buffers};

fn ms(ns: u64) -> f64 {
    ns as f64 / 1.0e6
}

fn assert_full_leaves() {
    let tree = build_tree(16);
    let leaves = leaf_ids(&tree);
    let mut buf = Buffers::new();
    let (indices, _, _) = traverse(&tree, 10_000, 0.0, [0.0, 0.0, 0.0], [0.0, 0.0, 1.0], &mut buf);
    let mut got = indices.clone();
    got.sort_unstable();
    let mut expect = leaves.clone();
    expect.sort_unstable();
    assert_eq!(got, expect, "full expansion must select every leaf");
}

fn assert_cap_keeps_root() {
    let tree = build_tree(16);
    let mut buf = Buffers::new();
    let (indices, _, _) = traverse(&tree, 1, 0.0, [0.0, 0.0, 0.0], [0.0, 0.0, 1.0], &mut buf);
    assert_eq!(indices, vec![0], "a one-splat cap emits the unexpanded root");
}

fn bench_at(leaf_target: usize, max_splats: usize, pixel_limit: f32, label: &str) {
    let tree = build_tree(leaf_target);
    let mut buf = Buffers::new();
    let origin = [0.0_f32, 0.0, 0.0];
    let forward = [0.0_f32, 0.0, 1.0];
    let _ = traverse(&tree, max_splats, pixel_limit, origin, forward, &mut buf);
    let (indices, counts, phases) = traverse(&tree, max_splats, pixel_limit, origin, forward, &mut buf);
    let total = phases.expand + phases.drain + phases.partition + phases.index_copy;
    println!(
        "{{\"label\":\"{label}\",\"leaf_target\":{leaf_target},\"max_splats\":{max_splats},\"pixel_limit\":{pixel_limit},\"tree_nodes\":{},\"output\":{},\"output_bytes\":{},\"pops\":{},\"pixel_tests\":{},\"heap_pushes\":{},\"leaf_emits\":{},\"below_limit_emits\":{},\"frontier_drains\":{},\"budget_stops\":{},\"checksum\":{},\"expand_ms\":{:.3},\"drain_ms\":{:.3},\"partition_ms\":{:.3},\"index_copy_ms\":{:.3},\"total_ms\":{:.3}}}",
        tree.len(),
        indices.len(),
        indices.len() * 4,
        counts.pops,
        counts.pixel_tests,
        counts.heap_pushes,
        counts.leaf_emits,
        counts.below_limit_emits,
        counts.frontier_drains,
        counts.budget_stops,
        checksum(&indices),
        ms(phases.expand),
        ms(phases.drain),
        ms(phases.partition),
        ms(phases.index_copy),
        ms(total),
    );
}

fn checksum(indices: &[u32]) -> u64 {
    indices.iter().fold(0u64, |acc, index| {
        acc.wrapping_mul(131).wrapping_add(*index as u64)
    })
}

fn assert_budget_is_structural() {
    let tree = build_tree(4_194_304);
    let mut buf = Buffers::new();
    let near = traverse(&tree, 3_750_000, 0.0, [0.0, 0.0, 0.0], [0.0, 0.0, 1.0], &mut buf);
    let far = traverse(&tree, 3_750_000, 0.0, [0.0, 0.0, 40.0], [0.0, 0.0, 1.0], &mut buf);
    assert_eq!(near.0.len(), 3_749_998);
    assert_eq!(far.0.len(), 3_749_998);
    assert_eq!(near.1.pixel_tests, 4_999_997);
    assert_eq!(far.1.pixel_tests, near.1.pixel_tests);
    assert_eq!(near.1.budget_stops, 1);
    assert_ne!(checksum(&near.0), checksum(&far.0));
}

fn bench_pair(leaf_target: usize, max_splats: usize) {
    let tree = build_tree(leaf_target);
    let mut buf = Buffers::new();
    let cases = [
        ("budget_3750k_near", [0.0_f32, 0.0, 0.0], 0.0_f32),
        ("budget_3750k_far", [0.0_f32, 0.0, 40.0], 0.0_f32),
        ("budget_200k_near", [0.0_f32, 0.0, 0.0], 0.0_f32),
        ("fov_limit_near", [0.0_f32, 0.0, 0.0], 0.001_f32),
        ("fov_limit_far", [0.0_f32, 0.0, 40.0], 0.001_f32),
    ];
    for (label, origin, pixel_limit) in cases {
        let cap = if label.starts_with("budget_200k") { 200_000 } else { max_splats };
        let _ = traverse(&tree, cap, pixel_limit, origin, [0.0, 0.0, 1.0], &mut buf);
        let (indices, counts, phases) = traverse(&tree, cap, pixel_limit, origin, [0.0, 0.0, 1.0], &mut buf);
        let total = phases.expand + phases.drain + phases.partition + phases.index_copy;
        println!(
            "{{\"label\":\"{label}\",\"leaf_target\":{leaf_target},\"max_splats\":{cap},\"pixel_limit\":{pixel_limit},\"origin_z\":{},\"tree_nodes\":{},\"output\":{},\"output_bytes\":{},\"pops\":{},\"pixel_tests\":{},\"heap_pushes\":{},\"leaf_emits\":{},\"below_limit_emits\":{},\"frontier_drains\":{},\"budget_stops\":{},\"checksum\":{},\"expand_ms\":{:.3},\"drain_ms\":{:.3},\"partition_ms\":{:.3},\"index_copy_ms\":{:.3},\"total_ms\":{:.3}}}",
            origin[2],
            tree.len(),
            indices.len(),
            indices.len() * 4,
            counts.pops,
            counts.pixel_tests,
            counts.heap_pushes,
            counts.leaf_emits,
            counts.below_limit_emits,
            counts.frontier_drains,
            counts.budget_stops,
            checksum(&indices),
            ms(phases.expand),
            ms(phases.drain),
            ms(phases.partition),
            ms(phases.index_copy),
            ms(total),
        );
    }
}

fn main() {
    assert_full_leaves();
    assert_cap_keeps_root();
    assert_budget_is_structural();
    println!("LOD_BENCH_ORACLE_OK");
    bench_at(4_096, 50_000, 0.0, "full_4k");
    bench_at(65_536, 200_000, 0.0, "full_64k");
    bench_at(262_144, 400_000, 0.0, "full_256k");
    bench_at(1_048_576, 1_500_000, 0.0, "full_1m");
    bench_at(262_144, 400_000, 10.0, "limit_stops_root");
    bench_pair(4_194_304, 3_750_000);
}
