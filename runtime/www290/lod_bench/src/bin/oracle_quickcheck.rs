/**
 * Oracle quickcheck: load synthetic tree, run traverse_lod with fixed viewpoints,
 * report operation counts for validation against WASM trace.
 */

use lod_bench::{build_tree, traverse, Buffers, Counts, PhasesNs};

fn main() {
    eprintln!("[*] Building quaternary tree...");
    let tree = build_tree(4_194_304);
    eprintln!("[+] Tree built: {} nodes", tree.len());

    let mut buf = Buffers::new();

    // Test viewpoints from Coit Tower trace (approximated from s2_travinner evidence)
    let viewpoints: Vec<([f32; 3], &str)> = vec![
        ([7.142_f32, 4.203_f32, -1.128_f32], "frame_0"),
        ([6.609_f32, 4.203_f32, -0.595_f32], "frame_1"),
        ([6.156_f32, 4.203_f32, -0.15_f32], "frame_2"),
        ([5.462_f32, 4.203_f32, 0.561_f32], "frame_3"),
        ([4.742_f32, 4.203_f32, 1.272_f32], "frame_4"),
        ([0.0_f32, 0.0_f32, 10.0_f32], "synthetic_front"),
        ([0.0_f32, 0.0_f32, 20.0_f32], "synthetic_far"),
    ];

    eprintln!("\n[*] Running traverse oracle on {} viewpoints...", viewpoints.len());

    let mut all_counts = Vec::new();
    for (pos, label) in &viewpoints {
        let origin = *pos;
        // Simple forward direction for each viewpoint (looking towards +z)
        let forward = [0.0_f32, 0.0_f32, 1.0_f32];

        let (indices, counts, phases) = traverse(
            &tree,
            20000,  // max_splats matching production
            0.0,    // pixel_limit
            origin,
            forward,
            &mut buf,
        );

        all_counts.push(counts);

        eprintln!(
            "  {}: indices={}, pops={}, pushes={}, pixel_tests={}, expand_ns={}",
            label, indices.len(), counts.pops, counts.heap_pushes, counts.pixel_tests, phases.expand
        );
    }

    // Summary statistics
    let avg_output: f64 = all_counts.iter().map(|c| c.leaf_emits as f64).sum::<f64>() / all_counts.len() as f64;
    let avg_pops: f64 = all_counts.iter().map(|c| c.pops as f64).sum::<f64>() / all_counts.len() as f64;
    let avg_pushes: f64 = all_counts.iter().map(|c| c.heap_pushes as f64).sum::<f64>() / all_counts.len() as f64;

    eprintln!("\n[+] Oracle summary:");
    eprintln!("  avg output indices: {:.0}", avg_output);
    eprintln!("  avg heap pops: {:.0}", avg_pops);
    eprintln!("  avg heap pushes: {:.0}", avg_pushes);
    eprintln!("[+] Quickcheck PASS (oracle runs successfully)");
}
