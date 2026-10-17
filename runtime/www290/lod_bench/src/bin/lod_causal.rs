use lod_bench::causal::{
    browser_view, checksum, identity_pages, pack_nodes, precompute_scales, sorted_copy, walk_binary,
    walk_binary_notouch, walk_binary_packed, walk_binary_table, walk_four,
};
use lod_bench::{build_tree, leaf_ids};

fn ms(ns: u64) -> f64 {
    ns as f64 / 1.0e6
}

fn median(samples: &mut [f64]) -> f64 {
    samples.sort_by(|a, b| a.partial_cmp(b).unwrap());
    samples[samples.len() / 2]
}

fn assert_oracles() {
    let tree = build_tree(4_096);
    let pages = identity_pages(tree.len());
    let view = browser_view([0.0, 0.0, 0.0], [0.0, 0.0, 1.0]);
    let leaves = leaf_ids(&tree);

    let full = walk_binary(&tree, &pages, 10_000_000, 0.0, &view);
    assert_eq!(sorted_copy(&full.indices), leaves, "full expansion must select every leaf");

    let capped = walk_binary(&tree, &pages, 1, 0.0, &view);
    assert_eq!(capped.indices, vec![0], "one-splat budget emits the root");

    let mut missing = pages.clone();
    missing[0] = u32::MAX;
    let missed = walk_binary(&tree, &missing, 10_000_000, 0.0, &view);
    assert_eq!(missed.indices, vec![0], "missing child page keeps the parent");
    assert_eq!(missed.counts.page_misses, 1);

    let scales = precompute_scales(&tree, &view);
    let table = walk_binary_table(&tree, &scales, &pages, 10_000_000, 0.0, &view);
    assert_eq!(sorted_copy(&table.indices), sorted_copy(&full.indices));
    assert_eq!(&table.indices[..table.pre_drain], &full.indices[..full.pre_drain]);

    let four = walk_four(&tree, &pages, 10_000_000, 0.0, &view);
    assert_eq!(sorted_copy(&four.indices), sorted_copy(&full.indices), "4-heap must keep the LOD set");
    assert_eq!(
        &four.indices[..four.pre_drain],
        &full.indices[..full.pre_drain],
        "4-heap pop order must match the binary heap before drain"
    );

    let stopped = walk_binary(&tree, &pages, 10_000_000, 1.0e9, &view);
    assert_eq!(stopped.indices, vec![0], "a limit above the root emits only the root");
    println!("LOD_CAUSAL_ORACLE_OK");
}

struct Timed {
    label: String,
    expand: Vec<f64>,
    drain: Vec<f64>,
    copy: Vec<f64>,
    output: usize,
    pushes: u64,
    pops: u64,
    pixel_evals: u64,
    budget_stops: u64,
    page_misses: u64,
    checksum: u64,
    sorted_checksum: u64,
    pre_drain: usize,
}

fn time_case(label: &str, mut run: impl FnMut() -> lod_bench::causal::Walk) -> Timed {
    let warm = run();
    let mut expand = Vec::new();
    let mut drain = Vec::new();
    let mut copy = Vec::new();
    let mut last = warm;
    for _ in 0..3 {
        last = run();
        expand.push(ms(last.phases.expand));
        drain.push(ms(last.phases.drain));
        copy.push(ms(last.phases.index_copy));
    }
    let sorted = sorted_copy(&last.indices);
    Timed {
        label: label.to_string(),
        expand,
        drain,
        copy,
        output: last.indices.len(),
        pushes: last.counts.pushes,
        pops: last.counts.pops,
        pixel_evals: last.counts.pixel_evals,
        budget_stops: last.counts.budget_stops,
        page_misses: last.counts.page_misses,
        checksum: checksum(&last.indices),
        sorted_checksum: checksum(&sorted),
        pre_drain: last.pre_drain,
    }
}

fn json_timed(row: &Timed, reference_sorted: u64) -> String {
    format!(
        "{{\"label\":\"{}\",\"expand_ms\":[{:.3},{:.3},{:.3}],\"expand_median_ms\":{:.3},\"drain_median_ms\":{:.3},\"index_copy_median_ms\":{:.3},\"output\":{},\"pre_drain\":{},\"pushes\":{},\"pops\":{},\"pixel_evals\":{},\"budget_stops\":{},\"page_misses\":{},\"checksum\":{},\"sorted_checksum\":{},\"set_matches_binary\":{}}}",
        row.label,
        row.expand[0],
        row.expand[1],
        row.expand[2],
        median(&mut row.expand.clone()),
        median(&mut row.drain.clone()),
        median(&mut row.copy.clone()),
        row.output,
        row.pre_drain,
        row.pushes,
        row.pops,
        row.pixel_evals,
        row.budget_stops,
        row.page_misses,
        row.checksum,
        row.sorted_checksum,
        if row.sorted_checksum == reference_sorted { "true" } else { "false" }
    )
}

fn bench_tree(leaf_target: usize, max_splats: usize, pixel_limit: f32, tag: &str) -> String {
    let tree = build_tree(leaf_target);
    let pages = identity_pages(tree.len());
    let view = browser_view([0.0, 0.0, 0.0], [0.0, 0.0, 1.0]);
    let scales = precompute_scales(&tree, &view);
    let packed = pack_nodes(&tree, &view);
    let binary = time_case("binary_live", || walk_binary(&tree, &pages, max_splats, pixel_limit, &view));
    let table = time_case("binary_table", || {
        walk_binary_table(&tree, &scales, &pages, max_splats, pixel_limit, &view)
    });
    let four = time_case("four_live", || walk_four(&tree, &pages, max_splats, pixel_limit, &view));
    let notouch = time_case("binary_notouch", || {
        walk_binary_notouch(&tree, &pages, max_splats, pixel_limit, &view)
    });
    let packed_row = time_case("binary_packed", || {
        walk_binary_packed(&packed, &pages, max_splats, pixel_limit)
    });
    let reference = binary.sorted_checksum;
    assert_eq!(table.sorted_checksum, reference, "table scales changed the LOD set");
    assert_eq!(four.sorted_checksum, reference, "4-heap changed the LOD set");
    assert_eq!(notouch.sorted_checksum, reference, "skipping the touched set changed the LOD set");
    assert_eq!(packed_row.sorted_checksum, reference, "packed nodes changed the LOD set");
    let live = median(&mut binary.expand.clone());
    let table_m = median(&mut table.expand.clone());
    let four_m = median(&mut four.expand.clone());
    let notouch_m = median(&mut notouch.expand.clone());
    let packed_m = median(&mut packed_row.expand.clone());
    format!(
        "{{\"tag\":\"{tag}\",\"leaf_target\":{leaf_target},\"tree_nodes\":{},\"max_splats\":{max_splats},\"pixel_limit\":{pixel_limit},\"rows\":[{},{},{},{},{}],\"ratios\":{{\"table_over_live\":{:.4},\"four_over_live\":{:.4},\"notouch_over_live\":{:.4},\"packed_over_live\":{:.4}}},\"h_scale_lt_0_60\":{},\"h_four_lt_0_80\":{},\"h_packed_lt_0_50\":{}}}",
        tree.len(),
        json_timed(&binary, reference),
        json_timed(&table, reference),
        json_timed(&four, reference),
        json_timed(&notouch, reference),
        json_timed(&packed_row, reference),
        table_m / live,
        four_m / live,
        notouch_m / live,
        packed_m / live,
        if table_m < 0.60 * live { "true" } else { "false" },
        if four_m < 0.80 * live { "true" } else { "false" },
        if packed_m < 0.50 * live { "true" } else { "false" }
    )
}

fn main() {
    assert_oracles();
    let full = bench_tree(65_536, 10_000_000, 0.0, "full_64k");
    let budget = bench_tree(4_194_304, 3_750_000, 0.0, "budget_3750k");
    let browser_limit = bench_tree(4_194_304, 3_750_000, 0.002131, "browser_pixel_limit");
    let body = format!(
        "{{\"oracle\":\"LOD_CAUSAL_ORACLE_OK\",\"profile\":\"opt-level 3, lto fat, codegen-units 1\",\"not_browser\":true,\"view\":\"streaming-lod coneFov0=70 coneFov=120 behindFoveate=0.2 coneFoveate=0.4 lodScale=1 forward=+Z\",\"preregistered\":{{\"h_scale\":\"binary_table expand median < 0.60 * binary_live\",\"h_four\":\"four_live expand median < 0.80 * binary_live and sorted indices identical\",\"h_packed\":\"binary_packed expand median < 0.50 * binary_live and sorted indices identical\"}},\"cases\":[{full},{budget},{browser_limit}]}}"
    );
    println!("{body}");
    std::fs::write(r"F:\WWW_N3_MUX\results\WWW291_HEAP_SCALE.json", body).expect("write result");
}
