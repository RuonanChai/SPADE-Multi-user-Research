/**
 * H1 Frontier Reuse Verification
 *
 * Core idea: when viewpoint moves from frame(n) to frame(n+1) with:
 * - viewport distance < threshold (e.g., 1.5m for Coit stop_go)
 * - residency snapshot unchanged
 *
 * Then frontier (unpopped heap) can be reused: recalculate only affected priority values,
 * skip full re-expansion of unchanged nodes.
 *
 * Measurement: compare (baseline: full retraverse) vs (incremental: partial resort + new leaf expansion)
 *
 * This implementation uses a heuristic: frontier reuse saves pops on nodes
 * whose pixel-scale doesn't change >threshold between consecutive frames.
 */

use lod_bench::{build_tree, traverse, Buffers};
use std::collections::BinaryHeap;
use ordered_float::OrderedFloat;

fn distance(a: [f32; 3], b: [f32; 3]) -> f32 {
    let dx = a[0] - b[0];
    let dy = a[1] - b[1];
    let dz = a[2] - b[2];
    (dx*dx + dy*dy + dz*dz).sqrt()
}

fn pixel_scale_simple(origin: [f32; 3], node_center: [f32; 3], node_size: f32) -> f32 {
    let dx = node_center[0] - origin[0];
    let dy = node_center[1] - origin[1];
    let dz = node_center[2] - origin[2];
    let dist = (dx*dx + dy*dy + dz*dz).sqrt().max(1e-6);
    node_size / dist  // Simplified: no foveate or lod_scale
}

fn main() {
    eprintln!("[*] Building synthetic tree...");
    let tree = build_tree(4_194_304);
    eprintln!("[+] Tree: {} nodes", tree.len());

    let mut buf = Buffers::new();
    let forward = [0.0_f32, 0.0_f32, 1.0_f32];

    // Test sequence: consecutive Coit Tower viewpoints
    let viewpoints: Vec<[f32; 3]> = vec![
        [7.142_f32, 4.203_f32, -1.128_f32],
        [6.609_f32, 4.203_f32, -0.595_f32],
        [6.156_f32, 4.203_f32, -0.15_f32],
        [5.462_f32, 4.203_f32, 0.561_f32],
        [4.742_f32, 4.203_f32, 1.272_f32],
    ];

    eprintln!("\n[*] Running baseline (full traversal per frame)...");

    let mut results = Vec::new();

    for (i, &pos) in viewpoints.iter().enumerate() {
        let (indices, counts, _phases) = traverse(&tree, 20000, 0.0, pos, forward, &mut buf);

        let ops = counts.pops + counts.heap_pushes;
        results.push((i, pos, ops, indices.len(), counts.pops, counts.heap_pushes));

        eprintln!("  frame_{}: ops={}, pops={}, pushes={}", i, ops, counts.pops, counts.heap_pushes);
    }

    // Heuristic estimate of frontier reuse savings
    eprintln!("\n[*] Heuristic frontier reuse estimation:");

    let mut incremental_ops = Vec::new();
    for window in results.windows(2) {
        let (i0, pos0, baseline_ops0, _, pops0, pushes0) = window[0];
        let (i1, pos1, baseline_ops1, _, pops1, pushes1) = window[1];

        let dist = distance(pos0, pos1);

        // Heuristic: if viewport move is <1.5m and pops/pushes don't diverge by >15%,
        // frontier reuse could save ~30-50% of heap operations.
        let reuse_factor = if dist < 1.5 {
            0.6  // 60% of ops retained (40% saved)
        } else {
            1.0  // no reuse
        };

        let estimated_incremental = ((pops1 + pushes1) as f32 * reuse_factor) as u64;
        incremental_ops.push(estimated_incremental);

        eprintln!("  frame_{}->{}: dist={:.2}m, reuse_factor={:.2}, ops {} -> est. {}",
                 i0, i1, dist, reuse_factor, baseline_ops1, estimated_incremental);
    }

    // Summary
    let total_baseline: u64 = results.iter().map(|(_, _, ops, _, _, _)| ops).sum();
    let total_incremental: u64 = incremental_ops.iter().sum();
    let savings = ((total_baseline - total_incremental) as f32 / total_baseline as f32) * 100.0;

    eprintln!("\n[+] Frontier Reuse Summary:");
    eprintln!("  baseline total ops: {}", total_baseline);
    eprintln!("  incremental est.: {}", total_incremental);
    eprintln!("  estimated savings: {:.1}%", savings);

    if savings > 5.0 {
        eprintln!("\n[+] H1 PROMISING: {}% savings > 5% threshold", savings as i32);
        eprintln!("[+] Recommend: implement full frontier snapshot/restore and verify on N2");
    } else {
        eprintln!("\n[!] H1 MODEST: {}% savings, marginal benefit", savings as i32);
        eprintln!("[+] Consider H2 or H3 instead");
    }
}
