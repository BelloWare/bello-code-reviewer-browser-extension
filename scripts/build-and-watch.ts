import { spawn } from "child_process";

function run(cmd: string, args: string[]) {
  const child = spawn(cmd, args, { stdio: "inherit" });
  child.on("close", (code) => {
    console.log(`[build-and-watch] ${cmd} ${args.join(" ")} exited with ${code}`);
  });
  return child;
}

run("npm", ["run", "dev:server"]);
run("npm", ["run", "dev:extension"]);
