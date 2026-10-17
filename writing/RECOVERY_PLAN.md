# 真实Coit输入恢复与捕获计划

**目标**：恢复或实施Coit树重放机制以供oracle和profiling。
**当前状态**：37/44物理尝试已完成；Coit树元数据未持久化。
**约束**：只有真正必要且预检通过才耗新物理预算。

## 第一阶段：检验现存恢复能力

### 1.1 证据梳理
- 最新VALID运行：nsdi_N2_LRU_coit-40m-sh1-lod_stop_go_g1_viteh1_s2_travinner_r1
- 已记录：
  - scene: `coit-40m-sh1-lod`
  - trace: `stop_go`
  - viewport: 1280x720
  - cameras位置列表（从C3_g0.jsonl）
  - rad_base: `/_p5rad/`
  - chunk ranges from network logs

### 1.2 缺失数据
- Splat树结构（中间节点子树、children索引、size字段）
- 驻留快照（哪些nodes在哪个时间戳resident）
- 完整LOD集合和遍历顺序验证

### 1.3 可尝试的恢复途径
1. Spark events中是否有tree expand/pop操作的序列（C3_spark_events.jsonl）
2. 网络chunk ranges是否与tree分割对应（从C3_g0.jsonl的range_start/end）
3. Vite服务器访问日志是否记录了tree加载顺序

## 第二阶段：如无法恢复，实施捕获器

若上述途径都不可行：
1. 修改现存www290 lod_bench，添加二进制tree导出选项
2. 将Coit tree（名义为4M叶子的quaternary tree）serialize到.bin
3. 从已有s2_travinner运行中提取viewport序列，与tree合成入cache场景
4. 编写local-only quickcheck来验证oracle一致性（π<30ms）

## 第三阶段：建立oracle

- 输入：tree (Node[]), viewports (Camera[]), maxSplats, pixel_limit
- 输出：LOD indices[], 操作计数(pops, pushes, pixel_tests等)
- 差分与现存WASM traverse_lod对标

## 预检门槛
- oracle在local合成场景过关（误差<5%）
- 捕获器低开销验证通过（单次<50ms）
- 若需新物理尝试（下载Coit或重新运行树capture），需单独授权

**下一步**：立即启动阶段1检验。
