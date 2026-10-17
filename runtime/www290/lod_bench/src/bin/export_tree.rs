use lod_bench::build_tree;
use std::fs::File;
use std::io::Write;

fn main() -> std::io::Result<()> {
    // Build synthetic quaternary tree matching 4M leaf target
    let tree = build_tree(4_194_304);

    // Serialize as JSON for easy inspection and replay
    let mut output = Vec::new();
    output.push(b'{');

    writeln!(&mut output, "  \"node_count\": {},", tree.len())?;
    writeln!(&mut output, "  \"leaf_target\": 4194304,")?;
    output.push(b' ');
    writeln!(&mut output, "\"nodes\": [")?;

    for (i, node) in tree.iter().enumerate() {
        let center_x = node.center[0].to_f32();
        let center_y = node.center[1].to_f32();
        let center_z = node.center[2].to_f32();
        let size = node.size.to_f32();

        write!(&mut output, "    {{")?;
        write!(&mut output, "\"i\":{},", i)?;
        write!(&mut output, "\"x\":{:.6},", center_x)?;
        write!(&mut output, "\"y\":{:.6},", center_y)?;
        write!(&mut output, "\"z\":{:.6},", center_z)?;
        write!(&mut output, "\"s\":{:.6},", size)?;
        write!(&mut output, "\"cs\":{},", node.child_start)?;
        write!(&mut output, "\"cc\":{}", node.child_count)?;
        if i < tree.len() - 1 {
            writeln!(&mut output, "}},")?;
        } else {
            writeln!(&mut output, "}}")?;
        }

        if i % 10000 == 0 && i > 0 {
            eprintln!("  serialized {} / {} nodes", i, tree.len());
        }
    }

    writeln!(&mut output, "  ]")?;
    writeln!(&mut output, "}}")?;

    let out_path = r"F:\WWW_N3_MUX\results\COIT_TREE_SYNTHETIC_4M.json";
    let mut file = File::create(out_path)?;
    file.write_all(&output)?;
    eprintln!("[+] Exported {} nodes to {}", tree.len(), out_path);

    Ok(())
}
