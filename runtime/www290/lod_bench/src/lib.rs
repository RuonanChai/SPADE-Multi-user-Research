//! Host reimplementation of spark-worker-rs traverse_lod_trees.
//! FourHeap in that file is dead code. The live frontier is a binary heap.
//! instance_output.sort_unstable is commented out there and is not done here.

pub mod causal;

use std::collections::BinaryHeap;

use half::f16;
use ordered_float::OrderedFloat;

#[derive(Clone, Copy)]
pub struct Splat {
    pub center: [f16; 3],
    pub size: f16,
    pub child_start: u32,
    pub child_count: u16,
}

#[derive(Clone, Copy, Default)]
pub struct Counts {
    pub pops: u64,
    pub pixel_tests: u64,
    pub heap_pushes: u64,
    pub leaf_emits: u64,
    pub below_limit_emits: u64,
    pub frontier_drains: u64,
    pub budget_stops: u64,
}

#[derive(Clone, Copy, Default)]
pub struct PhasesNs {
    pub expand: u64,
    pub drain: u64,
    pub partition: u64,
    pub index_copy: u64,
}

pub struct Buffers {
    pub frontier: BinaryHeap<(OrderedFloat<f32>, u32, u32)>,
    pub output: Vec<(u32, u32)>,
    pub flat: Vec<u32>,
}

impl Buffers {
    pub fn new() -> Self {
        Self {
            frontier: BinaryHeap::new(),
            output: Vec::new(),
            flat: Vec::new(),
        }
    }
}

fn pixel_scale(splat: &Splat, origin: [f32; 3], forward: [f32; 3], lod_scale: f32) -> f32 {
    let center = splat.center.map(f16::to_f32);
    let size = splat.size.to_f32();
    let delta = [
        center[0] - origin[0],
        center[1] - origin[1],
        center[2] - origin[2],
    ];
    let distance = (delta[0] * delta[0] + delta[1] * delta[1] + delta[2] * delta[2])
        .sqrt()
        .max(1.0e-6);
    let dot = (delta[0] * forward[0] + delta[1] * forward[1] + delta[2] * forward[2]) / distance;
    let foveate = if dot <= 0.0 { 0.2 } else { 1.0 };
    size / distance * lod_scale * foveate
}

fn phase_now() -> Option<std::time::Instant> {
    #[cfg(not(target_arch = "wasm32"))]
    {
        Some(std::time::Instant::now())
    }
    #[cfg(target_arch = "wasm32")]
    {
        None
    }
}

fn phase_elapsed(start: Option<std::time::Instant>) -> u64 {
    start.map(|mark| mark.elapsed().as_nanos() as u64).unwrap_or(0)
}

pub fn traverse(
    splats: &[Splat],
    max_splats: usize,
    pixel_limit: f32,
    origin: [f32; 3],
    forward: [f32; 3],
    buf: &mut Buffers,
) -> (Vec<u32>, Counts, PhasesNs) {
    let mut counts = Counts::default();
    let mut phases = PhasesNs::default();
    buf.frontier.clear();
    buf.output.clear();
    buf.output.reserve(max_splats);

    let expand_start = phase_now();
    let mut num_splats = 1usize;
    let root_scale = pixel_scale(&splats[0], origin, forward, 1.0);
    counts.pixel_tests += 1;
    buf.frontier
        .push((OrderedFloat(root_scale), 0, 0));
    counts.heap_pushes += 1;

    while let Some(&(OrderedFloat(scale), _inst, index)) = buf.frontier.peek() {
        if scale <= pixel_limit {
            break;
        }
        let splat = splats[index as usize];
        if splat.child_count == 0 {
            buf.frontier.pop();
            counts.pops += 1;
            buf.output.push((0, index));
            counts.leaf_emits += 1;
            continue;
        }
        let new_num = num_splats - 1 + splat.child_count as usize;
        if new_num > max_splats {
            counts.budget_stops += 1;
            break;
        }
        buf.frontier.pop();
        counts.pops += 1;
        for child in splat.child_start..splat.child_start + splat.child_count as u32 {
            let child_splat = &splats[child as usize];
            let child_scale = pixel_scale(child_splat, origin, forward, 1.0);
            counts.pixel_tests += 1;
            if child_scale <= pixel_limit {
                buf.output.push((0, child));
                counts.below_limit_emits += 1;
            } else {
                buf.frontier
                    .push((OrderedFloat(child_scale), 0, child));
                counts.heap_pushes += 1;
            }
        }
        num_splats = new_num;
    }
    phases.expand = phase_elapsed(expand_start);

    let drain_start = phase_now();
    for (_, _, index) in buf.frontier.drain() {
        buf.output.push((0, index));
        counts.frontier_drains += 1;
    }
    phases.drain = phase_elapsed(drain_start);

    let part_start = phase_now();
    let mut indices = Vec::with_capacity(buf.output.len());
    for &(_, index) in &buf.output {
        indices.push(index);
    }
    phases.partition = phase_elapsed(part_start);

    let copy_start = phase_now();
    let rows = indices.len().div_ceil(16384);
    let capacity = rows * 16384;
    buf.flat.clear();
    buf.flat.resize(capacity, 0);
    buf.flat[..indices.len()].copy_from_slice(&indices);
    phases.index_copy = phase_elapsed(copy_start);

    (indices, counts, phases)
}

pub fn build_tree(leaf_target: usize) -> Vec<Splat> {
    let mut nodes = vec![Splat {
        center: [f16::from_f32(0.0), f16::from_f32(0.0), f16::from_f32(8.0)],
        size: f16::from_f32(4.0),
        child_start: 0,
        child_count: 0,
    }];
    let mut level = vec![0u32];
    while level.len() < leaf_target {
        let mut next = Vec::new();
        for parent in &level {
            let start = nodes.len() as u32;
            let parent_center = nodes[*parent as usize].center.map(f16::to_f32);
            let parent_size = nodes[*parent as usize].size.to_f32();
            for child in 0..4 {
                let offset = (child as f32 - 1.5) * parent_size * 0.25;
                nodes.push(Splat {
                    center: [
                        f16::from_f32(parent_center[0] + offset),
                        f16::from_f32(parent_center[1]),
                        f16::from_f32(parent_center[2] + 0.5),
                    ],
                    size: f16::from_f32(parent_size * 0.5),
                    child_start: 0,
                    child_count: 0,
                });
                next.push(nodes.len() as u32 - 1);
            }
            nodes[*parent as usize].child_start = start;
            nodes[*parent as usize].child_count = 4;
        }
        level = next;
        if nodes.len() > leaf_target.saturating_mul(2).max(8) && level.len() >= leaf_target {
            break;
        }
    }
    nodes
}

pub fn leaf_ids(splats: &[Splat]) -> Vec<u32> {
    splats
        .iter()
        .enumerate()
        .filter_map(|(index, splat)| (splat.child_count == 0).then_some(index as u32))
        .collect()
}

#[no_mangle]
pub extern "C" fn wasm_leaf_count(leaf_target: u32) -> u32 {
    leaf_ids(&build_tree(leaf_target as usize)).len() as u32
}

use std::cell::RefCell;
use std::sync::OnceLock;

use wasm_bindgen::prelude::wasm_bindgen;

static PREPARED: OnceLock<Vec<Splat>> = OnceLock::new();

thread_local! {
    static REUSED: RefCell<Buffers> = RefCell::new(Buffers::new());
}

#[wasm_bindgen]
pub fn prepare_tree() -> u32 {
    PREPARED.get_or_init(|| build_tree(4_194_304)).len() as u32
}

#[wasm_bindgen]
pub fn run_cap(max_splats: u32, origin_z: f32) -> u32 {
    let tree = PREPARED.get().expect("prepare_tree");
    REUSED.with(|buf| {
        let (indices, _, _) = traverse(
            tree,
            max_splats as usize,
            0.0,
            [0.0, 0.0, origin_z],
            [0.0, 0.0, 1.0],
            &mut buf.borrow_mut(),
        );
        indices.len() as u32
    })
}
