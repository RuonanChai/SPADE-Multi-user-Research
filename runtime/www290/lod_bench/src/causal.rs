//! Host model of the live `traverse_lod_trees` loop in spark-worker-rs `lod_tree.rs`.
//! The production frontier is `BinaryHeap`. `FourHeap` in that file is `dead_code`.
//! This module does not claim browser timings. Index order after `drain` is not an
//! oracle: `BinaryHeap::drain` is arbitrary. The LOD contract checked here is the
//! sorted index set, plus emission order only for the pre-drain prefix.

use std::cell::RefCell;
use std::collections::{BinaryHeap, HashSet};
use std::time::Instant;

use half::f16;
use ordered_float::OrderedFloat;

use crate::Splat;

#[derive(Clone, Copy)]
pub struct View {
    pub origin: [f32; 3],
    pub forward: [f32; 3],
    pub lod_scale: f32,
    pub behind_foveate: f32,
    pub cone_foveate: f32,
    pub cone_dot0: f32,
    pub cone_dot: f32,
}

/// streaming-lod defaults: coneFov0=70, coneFov=120, behindFoveate=0.2, coneFoveate=0.4, lodScale=1.
pub fn browser_view(origin: [f32; 3], forward: [f32; 3]) -> View {
    let cone_dot0 = (0.5 * 70.0_f32).to_radians().cos();
    let mut cone_dot = (0.5 * 120.0_f32).to_radians().cos();
    cone_dot = cone_dot.min(cone_dot0);
    View {
        origin,
        forward,
        lod_scale: 1.0,
        behind_foveate: 0.2,
        cone_foveate: 0.4,
        cone_dot0,
        cone_dot,
    }
}

pub fn production_pixel_scale(splat: &Splat, view: &View) -> f32 {
    let center = splat.center.map(f16::to_f32);
    let delta = [
        center[0] - view.origin[0],
        center[1] - view.origin[1],
        center[2] - view.origin[2],
    ];
    let distance = (delta[0] * delta[0] + delta[1] * delta[1] + delta[2] * delta[2])
        .sqrt()
        .max(1.0e-6);
    let inv_distance = 1.0 / distance;
    let pixel_scale = splat.size.to_f32() * inv_distance * view.lod_scale;
    let forward_dot = delta[0] * view.forward[0] + delta[1] * view.forward[1] + delta[2] * view.forward[2];
    let foveate = if forward_dot <= 0.0 {
        view.behind_foveate
    } else {
        let dot = forward_dot * inv_distance;
        if dot >= view.cone_dot0 {
            1.0
        } else if dot >= view.cone_dot {
            let t = (dot - view.cone_dot) / (view.cone_dot0 - view.cone_dot);
            view.cone_foveate + (1.0 - view.cone_foveate) * t
        } else {
            let t = dot / view.cone_dot;
            view.behind_foveate + (view.cone_foveate - view.behind_foveate) * t
        }
    };
    foveate * pixel_scale
}

pub fn identity_pages(n_splats: usize) -> Vec<u32> {
    if n_splats == 0 {
        return Vec::new();
    }
    let nchunks = ((n_splats - 1) >> 16) + 1;
    (0..nchunks as u32).collect()
}

#[derive(Clone, Copy, Default)]
pub struct Counts {
    pub pushes: u64,
    pub pops: u64,
    pub pixel_evals: u64,
    pub leaf_emits: u64,
    pub below_limit_emits: u64,
    pub page_misses: u64,
    pub budget_stops: u64,
    pub frontier_drains: u64,
    pub touched_inserts: u64,
}

#[derive(Clone, Copy, Default)]
pub struct PhasesNs {
    pub expand: u64,
    pub drain: u64,
    pub index_copy: u64,
}

pub struct Walk {
    pub indices: Vec<u32>,
    pub pre_drain: usize,
    pub counts: Counts,
    pub phases: PhasesNs,
}

trait NodeKey: Ord + Copy {
    fn scale(self) -> f32;
    fn inst(self) -> u32;
    fn index(self) -> u32;
    fn new(scale: f32, inst: u32, index: u32) -> Self;
}

impl NodeKey for (OrderedFloat<f32>, u32, u32) {
    fn scale(self) -> f32 {
        self.0 .0
    }
    fn inst(self) -> u32 {
        self.1
    }
    fn index(self) -> u32 {
        self.2
    }
    fn new(scale: f32, inst: u32, index: u32) -> Self {
        (OrderedFloat(scale), inst, index)
    }
}

trait Frontier<K: NodeKey> {
    fn reset(&mut self);
    fn push_item(&mut self, key: K);
    fn peek_item(&self) -> Option<&K>;
    fn pop_item(&mut self) -> Option<K>;
    fn drain_into(&mut self, out: &mut Vec<(u32, u32)>);
}

struct BinFrontier(BinaryHeap<(OrderedFloat<f32>, u32, u32)>);

impl Frontier<(OrderedFloat<f32>, u32, u32)> for BinFrontier {
    fn reset(&mut self) {
        self.0.clear();
    }
    fn push_item(&mut self, key: (OrderedFloat<f32>, u32, u32)) {
        self.0.push(key);
    }
    fn peek_item(&self) -> Option<&(OrderedFloat<f32>, u32, u32)> {
        self.0.peek()
    }
    fn pop_item(&mut self) -> Option<(OrderedFloat<f32>, u32, u32)> {
        self.0.pop()
    }
    fn drain_into(&mut self, out: &mut Vec<(u32, u32)>) {
        for key in self.0.drain() {
            out.push((key.inst(), key.index()));
        }
    }
}

/// Faithful copy of the unused production FourHeap. Not on the live path.
struct FourHeap<T> {
    data: Vec<T>,
}

impl<T: Ord> FourHeap<T> {
    fn new() -> Self {
        Self { data: Vec::new() }
    }

    fn push(&mut self, value: T) {
        self.data.push(value);
        let mut index = self.data.len() - 1;
        while index > 0 {
            let parent = (index - 1) / 4;
            if self.data[parent] >= self.data[index] {
                break;
            }
            self.data.swap(parent, index);
            index = parent;
        }
    }

    fn peek(&self) -> Option<&T> {
        self.data.first()
    }

    fn pop(&mut self) -> Option<T> {
        let last = self.data.pop()?;
        if self.data.is_empty() {
            return Some(last);
        }
        let root = std::mem::replace(&mut self.data[0], last);
        let len = self.data.len();
        let mut index = 0usize;
        loop {
            let child0 = index * 4 + 1;
            if child0 >= len {
                break;
            }
            let child_end = (child0 + 4).min(len);
            let mut max_child = child0;
            for child in (child0 + 1)..child_end {
                if self.data[child] > self.data[max_child] {
                    max_child = child;
                }
            }
            if self.data[index] >= self.data[max_child] {
                break;
            }
            self.data.swap(index, max_child);
            index = max_child;
        }
        Some(root)
    }
}

impl<K: NodeKey> Frontier<K> for FourHeap<K> {
    fn reset(&mut self) {
        self.data.clear();
    }
    fn push_item(&mut self, key: K) {
        self.push(key);
    }
    fn peek_item(&self) -> Option<&K> {
        self.peek()
    }
    fn pop_item(&mut self) -> Option<K> {
        self.pop()
    }
    fn drain_into(&mut self, out: &mut Vec<(u32, u32)>) {
        for key in self.data.drain(..) {
            out.push((key.inst(), key.index()));
        }
    }
}

fn walk<K, F, const TABLE: bool, const TOUCH: bool>(
    splats: &[Splat],
    scales: &[f32],
    pages: &[u32],
    max_splats: usize,
    pixel_limit: f32,
    view: &View,
    frontier: &mut F,
) -> Walk
where
    K: NodeKey,
    F: Frontier<K>,
{
    thread_local! {
        static OUTPUT: RefCell<Vec<(u32, u32)>> = RefCell::new(Vec::new());
        static TOUCHED: RefCell<HashSet<(u32, u32)>> = RefCell::new(HashSet::new());
        static FLAT: RefCell<Vec<u32>> = RefCell::new(Vec::new());
    }
    let mut counts = Counts::default();
    let mut phases = PhasesNs::default();
    OUTPUT.with(|output_cell| TOUCHED.with(|touched_cell| FLAT.with(|flat_cell| {
    let mut output = output_cell.borrow_mut();
    let mut touched = touched_cell.borrow_mut();
    let mut flat = flat_cell.borrow_mut();
    output.clear();
    touched.clear();
    let want = max_splats.min(splats.len());
    if output.capacity() < want {
        output.reserve(want);
    }
    frontier.reset();

    let expand_start = Instant::now();
    let mut num_splats = 1usize;
    let root_scale = if TABLE {
        scales[0]
    } else {
        production_pixel_scale(&splats[0], view)
    };
    counts.pixel_evals += 1;
    frontier.push_item(K::new(root_scale, 0, 0));
    counts.pushes += 1;
    if TOUCH && touched.insert((0, 0)) {
        counts.touched_inserts += 1;
    }

    while let Some(top) = frontier.peek_item().copied() {
        let scale = top.scale();
        if scale <= pixel_limit {
            break;
        }
        let index = top.index();
        let splat = splats[index as usize];
        if splat.child_count == 0 {
            frontier.pop_item();
            counts.pops += 1;
            output.push((top.inst(), index));
            counts.leaf_emits += 1;
            continue;
        }
        let new_num = num_splats - 1 + splat.child_count as usize;
        if new_num > max_splats {
            counts.budget_stops += 1;
            break;
        }
        frontier.pop_item();
        counts.pops += 1;

        let first_chunk = splat.child_start >> 16;
        if TOUCH && touched.insert((0, first_chunk)) {
            counts.touched_inserts += 1;
        }
        let last_chunk = (splat.child_start + splat.child_count as u32 - 1) >> 16;
        if TOUCH && last_chunk != first_chunk && touched.insert((0, last_chunk)) {
            counts.touched_inserts += 1;
        }
        if last_chunk as usize >= pages.len()
            || pages[first_chunk as usize] == u32::MAX
            || pages[last_chunk as usize] == u32::MAX
        {
            output.push((top.inst(), index));
            counts.page_misses += 1;
            continue;
        }

        for child in splat.child_start..splat.child_start + splat.child_count as u32 {
            let child_chunk = (child >> 16) as usize;
            let child_page = pages[child_chunk];
            let paged = (child_page << 16) | (child & 0xffff);
            let child_scale = if TABLE {
                scales[paged as usize]
            } else {
                production_pixel_scale(&splats[paged as usize], view)
            };
            counts.pixel_evals += 1;
            if child_scale <= pixel_limit {
                output.push((0, paged));
                counts.below_limit_emits += 1;
            } else {
                frontier.push_item(K::new(child_scale, 0, paged));
                counts.pushes += 1;
            }
        }
        num_splats = new_num;
    }
    phases.expand = expand_start.elapsed().as_nanos() as u64;
    let pre_drain = output.len();

    let drain_start = Instant::now();
    let before = output.len();
    frontier.drain_into(&mut output);
    counts.frontier_drains = (output.len() - before) as u64;
    phases.drain = drain_start.elapsed().as_nanos() as u64;

    let copy_start = Instant::now();
    let mut indices = Vec::with_capacity(output.len());
    for &(_, index) in output.iter() {
        indices.push(index);
    }
    let rows = indices.len().div_ceil(16384);
    let capacity = rows * 16384;
    flat.clear();
    flat.resize(capacity, 0);
    flat[..indices.len()].copy_from_slice(&indices);
    phases.index_copy = copy_start.elapsed().as_nanos() as u64;
    std::hint::black_box(flat.len());

    Walk {
        indices,
        pre_drain,
        counts,
        phases,
    }
    })))
}

pub fn walk_binary(splats: &[Splat], pages: &[u32], max_splats: usize, pixel_limit: f32, view: &View) -> Walk {
    thread_local! {
        static FRONTIER: RefCell<BinFrontier> = RefCell::new(BinFrontier(BinaryHeap::new()));
    }
    FRONTIER.with(|frontier| {
        walk::<(OrderedFloat<f32>, u32, u32), _, false, true>(
            splats,
            &[],
            pages,
            max_splats,
            pixel_limit,
            view,
            &mut *frontier.borrow_mut(),
        )
    })
}

pub fn walk_binary_table(
    splats: &[Splat],
    scales: &[f32],
    pages: &[u32],
    max_splats: usize,
    pixel_limit: f32,
    view: &View,
) -> Walk {
    thread_local! {
        static FRONTIER: RefCell<BinFrontier> = RefCell::new(BinFrontier(BinaryHeap::new()));
    }
    FRONTIER.with(|frontier| {
        walk::<(OrderedFloat<f32>, u32, u32), _, true, true>(
            splats,
            scales,
            pages,
            max_splats,
            pixel_limit,
            view,
            &mut *frontier.borrow_mut(),
        )
    })
}

pub fn walk_binary_notouch(
    splats: &[Splat],
    pages: &[u32],
    max_splats: usize,
    pixel_limit: f32,
    view: &View,
) -> Walk {
    thread_local! {
        static FRONTIER: RefCell<BinFrontier> = RefCell::new(BinFrontier(BinaryHeap::new()));
    }
    FRONTIER.with(|frontier| {
        walk::<(OrderedFloat<f32>, u32, u32), _, false, false>(
            splats,
            &[],
            pages,
            max_splats,
            pixel_limit,
            view,
            &mut *frontier.borrow_mut(),
        )
    })
}

pub fn walk_four(splats: &[Splat], pages: &[u32], max_splats: usize, pixel_limit: f32, view: &View) -> Walk {
    thread_local! {
        static FRONTIER: RefCell<FourHeap<(OrderedFloat<f32>, u32, u32)>> =
            RefCell::new(FourHeap { data: Vec::new() });
    }
    FRONTIER.with(|frontier| {
        walk::<(OrderedFloat<f32>, u32, u32), _, false, true>(
            splats,
            &[],
            pages,
            max_splats,
            pixel_limit,
            view,
            &mut *frontier.borrow_mut(),
        )
    })
}

#[derive(Clone, Copy)]
pub struct Packed {
    pub child_start: u32,
    pub child_count: u16,
    pub scale: f32,
}

pub fn pack_nodes(splats: &[Splat], view: &View) -> Vec<Packed> {
    splats
        .iter()
        .map(|splat| Packed {
            child_start: splat.child_start,
            child_count: splat.child_count,
            scale: production_pixel_scale(splat, view),
        })
        .collect()
}

pub fn walk_binary_packed(nodes: &[Packed], pages: &[u32], max_splats: usize, pixel_limit: f32) -> Walk {
    thread_local! {
        static FRONTIER: RefCell<BinFrontier> = RefCell::new(BinFrontier(BinaryHeap::new()));
    }
    FRONTIER.with(|frontier| {
        let frontier = &mut *frontier.borrow_mut();
        thread_local! {
            static OUTPUT: RefCell<Vec<(u32, u32)>> = RefCell::new(Vec::new());
            static TOUCHED: RefCell<HashSet<(u32, u32)>> = RefCell::new(HashSet::new());
            static FLAT: RefCell<Vec<u32>> = RefCell::new(Vec::new());
        }
        OUTPUT.with(|output_cell| TOUCHED.with(|touched_cell| FLAT.with(|flat_cell| {
            let mut output = output_cell.borrow_mut();
            let mut touched = touched_cell.borrow_mut();
            let mut flat = flat_cell.borrow_mut();
            output.clear();
            touched.clear();
            frontier.reset();
            let mut counts = Counts::default();
            let mut phases = PhasesNs::default();
            let expand_start = Instant::now();
            let mut num_splats = 1usize;
            counts.pixel_evals += 1;
            frontier.push_item((OrderedFloat(nodes[0].scale), 0, 0));
            counts.pushes += 1;
            if touched.insert((0, 0)) {
                counts.touched_inserts += 1;
            }
            while let Some(top) = frontier.peek_item().copied() {
                if top.scale() <= pixel_limit {
                    break;
                }
                let index = top.index();
                let node = nodes[index as usize];
                if node.child_count == 0 {
                    frontier.pop_item();
                    counts.pops += 1;
                    output.push((top.inst(), index));
                    counts.leaf_emits += 1;
                    continue;
                }
                let new_num = num_splats - 1 + node.child_count as usize;
                if new_num > max_splats {
                    counts.budget_stops += 1;
                    break;
                }
                frontier.pop_item();
                counts.pops += 1;
                let first_chunk = node.child_start >> 16;
                if touched.insert((0, first_chunk)) {
                    counts.touched_inserts += 1;
                }
                let last_chunk = (node.child_start + node.child_count as u32 - 1) >> 16;
                if last_chunk != first_chunk && touched.insert((0, last_chunk)) {
                    counts.touched_inserts += 1;
                }
                if last_chunk as usize >= pages.len()
                    || pages[first_chunk as usize] == u32::MAX
                    || pages[last_chunk as usize] == u32::MAX
                {
                    output.push((top.inst(), index));
                    counts.page_misses += 1;
                    continue;
                }
                for child in node.child_start..node.child_start + node.child_count as u32 {
                    let child_chunk = (child >> 16) as usize;
                    let paged = (pages[child_chunk] << 16) | (child & 0xffff);
                    let child_scale = nodes[paged as usize].scale;
                    counts.pixel_evals += 1;
                    if child_scale <= pixel_limit {
                        output.push((0, paged));
                        counts.below_limit_emits += 1;
                    } else {
                        frontier.push_item((OrderedFloat(child_scale), 0, paged));
                        counts.pushes += 1;
                    }
                }
                num_splats = new_num;
            }
            phases.expand = expand_start.elapsed().as_nanos() as u64;
            let pre_drain = output.len();
            let drain_start = Instant::now();
            let before = output.len();
            frontier.drain_into(&mut output);
            counts.frontier_drains = (output.len() - before) as u64;
            phases.drain = drain_start.elapsed().as_nanos() as u64;
            let copy_start = Instant::now();
            let mut indices = Vec::with_capacity(output.len());
            for &(_, index) in output.iter() {
                indices.push(index);
            }
            flat.clear();
            flat.resize(indices.len().div_ceil(16384) * 16384, 0);
            flat[..indices.len()].copy_from_slice(&indices);
            phases.index_copy = copy_start.elapsed().as_nanos() as u64;
            std::hint::black_box(flat.len());
            Walk { indices, pre_drain, counts, phases }
        })))
    })
}

pub fn precompute_scales(splats: &[Splat], view: &View) -> Vec<f32> {
    splats.iter().map(|splat| production_pixel_scale(splat, view)).collect()
}

pub fn sorted_copy(indices: &[u32]) -> Vec<u32> {
    let mut out = indices.to_vec();
    out.sort_unstable();
    out
}

pub fn checksum(indices: &[u32]) -> u64 {
    indices.iter().fold(0u64, |acc, index| acc.wrapping_mul(131).wrapping_add(*index as u64))
}
