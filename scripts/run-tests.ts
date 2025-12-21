const API = process.env.DEBUG_SERVER_URL || "http://localhost:3030";
const DEBUG_TOKEN = process.env.X_DEBUG_TOKEN_BLLO_CODE_REVIEWER || "";

async function post(path: string, body: any) {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Token": DEBUG_TOKEN },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`${path} failed: ${res.status}`);
  return res.json();
}

async function get(path: string) {
  const res = await fetch(`${API}${path}`, {
    headers: { "X-Debug-Token": DEBUG_TOKEN }
  });
  if (!res.ok) throw new Error(`${path} failed: ${res.status}`);
  return res.json();
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log("[tests] resetting session");
  await post("/session/reset", {});

  console.log("[tests] queueing testNotification");
  await post("/command", { type: "testNotification", payload: { message: "Hello from run-tests" } });

  console.log("[tests] waiting for results...");
  let attempts = 0;
  while (attempts < 10) {
    const data = await get("/results?limit=10");
    const ok = data.results?.find((r: any) => r.summary?.includes("Notification"));
    if (ok) {
      console.log("[tests] got result:", ok.summary);
      return;
    }
    attempts += 1;
    await sleep(2000);
  }
  throw new Error("No results received; ensure extension is running in debug mode");
}

main().catch((err) => {
  console.error("[tests] failed", err);
  process.exit(1);
});
