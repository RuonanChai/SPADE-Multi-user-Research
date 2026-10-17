/**
 * H1 Correctness Test: Implement minimal frontier reuse and verify output
 *
 * Core: on viewpoint change, attempt to recalculate frontier priorities
 * instead of full re-traversal. Verify output matches baseline.
 *
 * CRITICAL: correctness comes first. No perf claims without correctness.
 */

use lod_bench::{build_tree, traverse, Buffers};

fn traverse_h1_attempt(
    tree: &[lod_bench::Splat],
    max_splats: usize,
    pixel_limit: f32,
    origin_prev: Option<[f32; 3]>,
    origin_new: [f32; 3],
    forward: [f32; 3],
    buf: &mut Buffers,
    prior_frontier: Option<Vec<(f32, u32)>>,
) -> (Vec<u32>, bool) {
    // H1 Attempt: if viewpoint distance < 1.5m AND frontier available,
    // recalculate priorities without full re-expansion.

    let reuse_applicable = if let Some(prior_pos) = origin_prev {
        let dx = origin_new[0] - prior_pos[0];
        let dy = origin_new[1] - prior_pos[1];
        let dz = origin_new[2] - prior_pos[2];
        let dist = (dx*dx + dy*dy + dz*dz).sqrt();
        dist < 1.5  // Distance threshold
    } else {
        false
    };

    let use_reuse = reuse_applicable && prior_frontier.is_some();

    if use_reuse {
        // H1 Path: attempt frontier reuse
        buf.frontier.clear();
        let frontier = prior_frontier.unwrap();

        for (_, idx) in frontier {
            let splat = tree[idx as usize];
            // Recalculate pixel_scale on new viewpoint
            let center = [
                splat.center[0].to_f32(),
                splat.center[1].to_f32(),
                splat.center[2].to_f32(),
            ];
            let size = splat.size.to_f32();
            let delta = [
                center[0] - origin_new[0],
                center[1] - origin_new[1],
                center[2] - origin_new[2],
            ];
            let distance = (delta[0]*delta[0] + delta[1]*delta[1] + delta[2]*delta[2])
                .sqrt()
                .max(1e-6);
            let new_scale = size / distance;  // Simplified: no foveate

            buf.frontier.push((ordered_float::OrderedFloat(new_scale), 0, idx));
        }
    } else {
        // No reuse: standard init
        let root = tree[0];
        let root_scale = {
            let center = [
                root.center[0].to_f32(),
                root.center[1].to_f32(),
                root.center[2].to_f32(),
            ];
            let size = root.size.to_f32();
            let delta = [
                center[0] - origin_new[0],
                center[1] - origin_new[1],
                center[2] - origin_new[2],
            ];
            let distance = (delta[0]*delta[0] + delta[1]*delta[1] + delta[2]*delta[2])
                .sqrt()
                .max(1e-6);
            size / distance
        };
        buf.frontier.push((ordered_float::OrderedFloat(root_scale), 0, 0));
    }

    // Continue standard traversal from frontier
    let mut output = Vec::new();
    while let Some(&(ordered_float::OrderedFloat(scale), _inst, index)) = buf.frontier.peek() {
        if scale <= pixel_limit {
            break;
        }
        let splat = tree[index as usize];
        if splat.child_count == 0 {
            buf.frontier.pop();
            output.push(index);
            continue;
        }
        let new_num = output.len() + 1 - 1 + splat.child_count as usize;
        if new_num > max_splats {
            break;
        }
        buf.frontier.pop();
        for child in splat.child_start..splat.child_start + splat.child_count as u32 {
            let child_splat = &tree[child as usize];
            let center = [
                child_splat.center[0].to_f32(),
                child_splat.center[1].to_f32(),
                child_splat.center[2].to_f32(),
            ];
            let size = child_splat.size.to_f32();
            let delta = [
                center[0] - origin_new[0],
                center[1] - origin_new[1],
                center[2] - origin_new[2],
            ];
            let distance = (delta[0]*delta[0] + delta[1]*delta[1] + delta[2]*delta[2])
                .sqrt()
                .max(1e-6);
            let child_scale = size / distance;

            if child_scale <= pixel_limit {
                output.push(child);
            } else {
                buf.frontier.push((ordered_float::OrderedFloat(child_scale), 0, child));
            }
        }
    }

    // Drain frontier
    while let Some((_, _, idx)) = buf.frontier.pop() {
        output.push(idx);
    }

    (output, use_reuse)
}

use ordered_float::OrderedFloat;

fn main() {
    eprintln!("[*] H1 Correctness Test: frontier reuse validity");
    let tree = build_tree(4_194_304);
    eprintln!("[+] Tree: {} nodes", tree.len());

    // Test frame sequence
    let frames = vec![
        ([7.142_f32, 4.203_f32, -1.128_f32], "frame_0"),
        ([6.609_f32, 4.203_f32, -0.595_f32], "frame_1"),
        ([6.156_f32, 4.203_f32, -0.15_f32], "frame_2"),
        ([5.462_f32, 4.203_f32, 0.561_f32], "frame_3"),
    ];

    let mut buf = Buffers::new();
    let forward = [0.0_f32, 0.0_f32, 1.0_f32];

    eprintln!("\n[*] Running baseline for correctness reference:");
    let mut baseline_outputs = Vec::new();
    for (pos, label) in &frames {
        let (indices, _, _) = traverse(&tree, 3_750_000, 0.002131, *pos, forward, &mut buf);
        baseline_outputs.push(indices);
        eprintln!("  {}: {} indices", label, baseline_outputs.last().unwrap().len());
    }

    eprintln!("\n[*] CRITICAL: Verifying H1 does NOT produce different output");
    eprintln!("(Frontier reuse must not change the traversal result)");

    let mut all_pass = true;
    let mut prior_pos: Option<[f32; 3]> = None;
    let mut prior_frontier: Option<Vec<(f32, u32)>> = None;

    for (i, (pos, label)) in frames.iter().enumerate() {
        buf.frontier.clear();
        buf.output.clear();

        // Run standard baseline
        let (baseline, _, _) = traverse(&tree, 3_750_000, 0.002131, *pos, forward, &mut buf);

        // Run H1 attempt
        let (h1_attempt, used_reuse) = traverse_h1_attempt(
            &tree,
            3_750_000,
            0.002131,
            prior_pos,
            *pos,
            forward,
            &mut buf,
            prior_frontier.clone(),
        );

        // Compare
        let match_ok = baseline.len() == h1_attempt.len()
            && baseline.iter().zip(h1_attempt.iter()).all(|(a, b)| a == b);

        let status = if match_ok { "✓ PASS" } else { "✗ FAIL" };
        eprintln!(
            "{}: {} (baseline {} vs H1 {}, reuse_used={})",
            label,
            status,
            baseline.len(),
            h1_attempt.len(),
            used_reuse
        );

        if !match_ok {
            all_pass = false;
            eprintln!("  ERROR: output mismatch! H1 is INCORRECT.");
        }

        // Prepare for next iteration
        prior_pos = Some(*pos);
        prior_frontier = Some(
            buf.frontier
                .iter()
                .map(|(prio, _, idx)| (prio.0, *idx))
                .collect(),
        );
    }

    eprintln!("\n[+] H1 Correctness: {}", if all_pass { "PASS" } else { "FAIL" });
    if !all_pass {
        eprintln!("[!] H1 implementation INCORRECT - frontier reuse changes output");
        eprintln!("[!] Do not proceed with H1 until correctness is fixed");
    } else {
        eprintln!("[+] H1 output matches baseline - ready for perf measurement");
    }
}
