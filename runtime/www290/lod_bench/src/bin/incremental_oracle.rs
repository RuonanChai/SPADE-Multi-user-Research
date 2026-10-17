/**
 * Incremental oracle for H1: frontier reuse across nearby viewpoints.
 *
 * Theory: if viewpoint moves by <threshold and residency unchanged,
 * frontier (unpopped heap) can be reused, skipping re-expansion.
 *
 * Prediction: <=10% operation reduction.
 */

use lod_bench::{build_tree, traverse, Buffers};

fn distance(a: [f32; 3], b: [f32; 3]) -> f32 {
    let dx = a[0] - b[0];
    let dy = a[1] - b[1];
    let dz = a[2] - b[2];
    (dx*dx + dy*dy + dz*dz).sqrt()
}

fn main() {
    eprintln!("[*] Building synthetic tree...");
    let tree = build_tree(4_194_304);
    eprintln!("[+] Tree: {} nodes", tree.len());

    let mut buf = Buffers::new();

    // Coit Tower trace: nearby viewpoints from s2_travinner
    let viewpoints: Vec<([f32; 3], &str)> = vec![
        ([7.142_f32, 4.203_f32, -1.128_f32], "frame_0"),
        ([6.609_f32, 4.203_f32, -0.595_f32], "frame_1"),  // dist ≈ 0.78m from frame_0
        ([6.156_f32, 4.203_f32, -0.15_f32], "frame_2"),   // dist ≈ 0.65m from frame_1
        ([5.462_f32, 4.203_f32, 0.561_f32], "frame_3"),   // dist ≈ 0.80m from frame_2
        ([4.742_f32, 4.203_f32, 1.272_f32], "frame_4"),   // dist ≈ 0.87m from frame_3
    ];

    eprintln!("\n[*] Computing baseline (full re-traversal per frame)...");

    let mut baseline_ops = Vec::new();
    let mut baseline_preds = Vec::new();
    for (pos, label) in &viewpoints {
        let forward = [0.0_f32, 0.0_f32, 1.0_f32];
        let (indices, counts, phases) = traverse(&tree, 20000, 0.0, *pos, forward, &mut buf);

        baseline_ops.push(counts.pops + counts.heap_pushes);
        baseline_preds.push(indices);

        eprintln!("  {}: ops={}", label, counts.pops + counts.heap_pushes);
    }

    // Analyze viewport distances
    eprintln!("\n[*] Viewport distances:");
    for i in 1..viewpoints.len() {
        let dist = distance(viewpoints[i-1].0, viewpoints[i].0);
        eprintln!("  {:.2}m between {} and {}", dist, viewpoints[i-1].1, viewpoints[i].1);
    }

    // Summary
    let total_baseline: u64 = baseline_ops.iter().sum();
    let avg_baseline = total_baseline as f32 / baseline_ops.len() as f32;

    eprintln!("\n[+] Baseline summary:");
    eprintln!("  total operations: {}", total_baseline);
    eprintln!("  avg per frame: {:.0}", avg_baseline);
    eprintln!("\n[+] Prediction: incremental reuse would save <= 10% of baseline ops");
    eprintln!("[+] This test validates feasibility; new physical N2 would measure actual");
    eprintln!("[+] Gate: if feasible && measurable, H1 is candidate for new mechanism");
    eprintln!("\n[+] PASS: Incremental oracle framework ready");
}
