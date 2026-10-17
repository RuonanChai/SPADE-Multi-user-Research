import { Client } from "ssh2";

const host = process.argv[2] || "10.120.17.176";
const user = process.argv[3] || "ddddd";
const pass = process.argv[4] || "ddddd";
const port = Number.parseInt(process.argv[5] || "8090", 10);
const remotePath = process.argv[6] || "/home/ddddd/download/Spark2.0/spark-main";

const conn = new Client();
conn
  .on("ready", () => {
    const cmd =
      `export NVM_DIR="$HOME/.nvm"; ` +
      `[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"; ` +
      `nvm use 20 >/dev/null 2>&1 || nvm use 18 >/dev/null 2>&1 || true; ` +
      `cd "${remotePath}" && npx vite --host 0.0.0.0 --port ${port} --strictPort`;
    conn.exec(cmd, (err, stream) => {
      if (err) {
        console.error(err);
        process.exit(1);
      }
      stream.on("data", (d) => process.stdout.write(d.toString()));
      stream.stderr.on("data", (d) => process.stderr.write(d.toString()));
      stream.on("close", (code) => {
        console.log(`\n[remote-vite-session] closed code=${code}`);
        conn.end();
        process.exit(code ?? 0);
      });
    });
  })
  .on("error", (e) => {
    console.error(e);
    process.exit(1);
  })
  .connect({
    host,
    username: user,
    password: pass,
    readyTimeout: 20000,
  });
