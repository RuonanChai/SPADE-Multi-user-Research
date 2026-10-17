# 两机四用户：总控+Worker1（本机）与 Worker2 部署说明

与 `bench-run-remote-ingest.js` 配合使用。远程页面服务（Vite + `/bench` + `/metrics/ingest`）地址以下记为 `SERVER`（例：`http://10.120.17.176:8090`）。

## 一、本机（总控 + Worker1）环境

在 **本机** 的 `spark-main` 根目录执行：

1. **Node.js**：20.x 或 18.x（`node -v` 检查）
2. **安装依赖**：
   ```bash
   cd spark-main
   npm install
   npx playwright install chromium
   ```
3. 确认能访问 `SERVER/bench`（浏览器或 `curl`）

## 二、单台跑完整 A/B/C（不调 worker2 时）

```bash
node bench-run-remote-ingest.js --server=SERVER --users=10 --repeats=5 --duration=120000 --scene=SCENE_URL --scene_version=你的版本 --sshHost=... --sshUser=... --sshPass=...
```

## 三、两机合跑「同一次 B 组」= 4 个用户（Worker1: user0–1，Worker2: user2–3）

### 1. 总控在本机做（**顺序很要紧**）

先约定一轮的 `run_id`（**两台机器命令里必须完全一致**），例如：

```text
RID=run-B-r1-20260422-manual-001
```

**① 开 bench 会话**（只调一次）：

```bash
curl -sS -X POST -H "content-type: application/json" -d "{\"run_id\":\"$RID\"}" "SERVER/bench/start"
```

**② 两路几乎同时开跑**（本机开终端 A，另一台开终端 B）：

**本机（Worker1，user0+user1）：**

```bash
node bench-run-remote-ingest.js --orchestrated=1 --runId=run-B-r1-20260422-manual-001 --server=SERVER --users=2 --userOffset=0 --duration=120000 --quality=high --scene=SCENE_URL --scene_version=你的版本
```

**Worker2 机器上（user2+user3）：**（`runId` 与上一条 **完全相同**）

```bash
node bench-run-remote-ingest.js --orchestrated=1 --runId=run-B-r1-20260422-manual-001 --server=SERVER --users=2 --userOffset=2 --duration=120000 --quality=high --scene=SCENE_URL --scene_version=你的版本
```

**③ 等两路都打印 `orchestrated worker done` 后**，总控再关 bench：

```bash
curl -sS -X POST -H "content-type: application/json" -d "{\"run_id\":\"$RID\"}" "SERVER/bench/stop"
```

**④ 只在本机** 用 SSH 从远端拉 `metrics.jsonl` 并筛 `run_id` 做分析，或把现有全量 `bench-run-remote-ingest` 的「分析段」单拆运行（你也可手动下载 jsonl 后只保留本 `RID` 相关行再跑分析脚本，若后续需要可再加 `--analyzeOnly` 参数）。

### 2. 参数含义

| 参数 | 说明 |
|------|------|
| `--orchestrated=1` | 不调用本进程内的 start/stop，只开浏览器与页面 |
| `--runId=` | 与 `curl` 的 `run_id` **字符串一致** |
| `--users=2` | 本机 2 个 Context |
| `--userOffset=0` 或 `2` | 生成 `user0–1` 或 `user2–3` |
| `SCENE_URL` | 如 R2：`https://pub-....r2.dev/assets/splats/butterfly.spz` |

## 四、Worker2 机器上部署（与 Worker1 相同）

1. 安装 **同版本 Node**（20 或 18）
2. 拷贝**同一套** `spark-main` 代码（与总控**同一 commit** 或同一份 zip），在工程根执行：
   ```bash
   npm install
   npx playwright install chromium
   ```
3. 无需配置 SSH 到远端；Worker2 只跑上面的 **`--orchestrated=1`** 一条命令
4. 防火墙/安全组：允许 **出站 HTTPS** 访问 R2 与 `SERVER` 的 `http` 端口

## 五、时序小提示

- ② 中两路**尽量同时启动**；若先 stop 再有一路未跑完，会少数据
- 若用 **git bash / WSL** 的 `&` 并行本机+SSH，可在一台总控上写小脚本；Windows 可开两个「终端」手动同步

## 六、A/C 组只有 1 个用户时

A 组（N=1）**只需 Worker1 单机**跑一个 browser、或走非 orchestrated 的整段脚本，无需 Worker2 参与 C 组同理若只测 1 低画质用户，可只开一台
