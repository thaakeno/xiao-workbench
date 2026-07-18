#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createInterface } from "node:readline";

const cliArgs = new Set(process.argv.slice(2));
const live = cliArgs.delete("--live");
const help = cliArgs.delete("--help") || cliArgs.delete("-h");
if (help) {
  console.log("Usage: npm run probe:codex -- [--live]");
  console.log("Without --live, validates schema and persistent thread resume without starting a model turn.");
  console.log("With --live, also probes concurrent turns, interruption, and approval recovery.");
  process.exit(0);
}
if (cliArgs.size) {
  console.error(`Unknown argument(s): ${[...cliArgs].join(", ")}`);
  process.exit(2);
}

const CODEX_BIN = process.env.CODEX_BIN || (process.platform === "win32" ? "codex.exe" : "codex");
const MAX_MESSAGES = 2_000;
const REQUEST_TIMEOUT_MS = 60_000;
const TURN_TIMEOUT_MS = 180_000;
const REQUIRED_METHODS = [
  "thread/start",
  "thread/resume",
  "thread/delete",
  "turn/start",
  "turn/interrupt",
];
const APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
]);

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

class AppServer {
  constructor({ cwd, sqliteHome }) {
    this.cwd = cwd;
    this.sqliteHome = sqliteHome;
    this.child = null;
    this.closed = null;
    this.nextId = 1;
    this.pending = new Map();
    this.messages = [];
    this.waiters = new Set();
    this.sequence = 0;
    this.stderr = "";
    this.expectedStop = false;
  }

  async start() {
    if (this.child) throw new Error("Probe app-server is already running.");
    await mkdir(this.sqliteHome, { recursive: true });

    const child = spawn(
      CODEX_BIN,
      ["app-server", "--stdio", "--enable", "default_mode_request_user_input"],
      {
        cwd: this.cwd,
        env: { ...process.env, CODEX_SQLITE_HOME: this.sqliteHome },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    this.child = child;
    this.expectedStop = false;
    this.closed = new Promise((resolve) => child.once("close", resolve));

    await new Promise((resolve, reject) => {
      const onError = (error) => reject(new Error(`Could not start Codex app-server: ${error.message}`));
      child.once("error", onError);
      child.once("spawn", () => {
        child.off("error", onError);
        resolve();
      });
    });

    createInterface({ input: child.stdout }).on("line", (line) => {
      if (!line.trim()) return;
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        this.fail(new Error(`Codex app-server emitted invalid JSON: ${error.message}`));
        return;
      }
      this.receive(message);
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-8_000);
    });
    child.once("close", (code) => {
      const suffix = this.stderr.trim() ? ` ${this.stderr.trim().slice(-1_000)}` : "";
      const error = new Error(`Codex app-server stopped with code ${String(code)}.${suffix}`);
      this.fail(error);
      this.child = null;
    });

    await this.request("initialize", {
      clientInfo: {
        name: "xiao_m0_protocol_probe",
        title: "Xiao M0 Protocol Probe",
        version: "1",
      },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized", {});
  }

  receive(message) {
    const entry = { sequence: ++this.sequence, message };
    this.messages.push(entry);
    if (this.messages.length > MAX_MESSAGES) this.messages.shift();

    if (message.method == null && message.id != null) {
      const pending = this.pending.get(String(message.id));
      if (pending) {
        this.pending.delete(String(message.id));
        clearTimeout(pending.timer);
        if (message.error) {
          pending.reject(new Error(message.error.message || "Codex request failed."));
        } else {
          pending.resolve(message.result);
        }
      }
    }

    for (const waiter of [...this.waiters]) {
      let matches = false;
      try {
        matches = waiter.predicate(message, entry.sequence);
      } catch (error) {
        clearTimeout(waiter.timer);
        this.waiters.delete(waiter);
        waiter.reject(error);
        continue;
      }
      if (!matches) continue;
      clearTimeout(waiter.timer);
      this.waiters.delete(waiter);
      waiter.resolve(entry);
    }
  }

  request(method, params = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    if (!this.child?.stdin?.writable) {
      return Promise.reject(new Error("Codex app-server stdin is unavailable."));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        reject(new Error(`Codex request ${method} timed out.`));
      }, timeoutMs);
      this.pending.set(String(id), { resolve, reject, timer });
      this.write({ method, id, params });
    });
  }

  reply(id, result) {
    this.write({ id, result });
  }

  notify(method, params = {}) {
    this.write({ method, params });
  }

  write(message) {
    if (!this.child?.stdin?.writable) throw new Error("Codex app-server stdin is unavailable.");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  waitFor(predicate, label, timeoutMs = REQUEST_TIMEOUT_MS, afterSequence = 0) {
    const existing = this.messages.find(
      (entry) => entry.sequence > afterSequence && predicate(entry.message, entry.sequence),
    );
    if (existing) return Promise.resolve(existing);

    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new Error(`Timed out waiting for ${label}.`));
      }, timeoutMs);
      this.waiters.add(waiter);
    });
  }

  fail(error) {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiters.clear();
  }

  async stop() {
    const child = this.child;
    if (!child) return;
    this.expectedStop = true;
    child.kill();
    await Promise.race([this.closed, delay(5_000)]);
    if (this.child === child) {
      child.kill("SIGKILL");
      await Promise.race([this.closed, delay(2_000)]);
    }
    this.child = null;
  }
}

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const textInput = (text) => [{ type: "text", text, text_elements: [] }];

const threadParams = (workspace, overrides = {}) => ({
  cwd: workspace,
  runtimeWorkspaceRoots: [workspace],
  approvalPolicy: "never",
  sandbox: "read-only",
  ephemeral: true,
  serviceName: "Xiao M0 Protocol Probe",
  threadSource: "xiao-workbench-m0-probe",
  ...overrides,
});

const terminalTurn = (message, threadId, turnId) =>
  message.method === "turn/completed" &&
  message.params?.threadId === threadId &&
  message.params?.turn?.id === turnId;

async function generateAndCheckSchema(root) {
  const schemaDir = join(root, "schema");
  await mkdir(schemaDir, { recursive: true });
  execFileSync(
    CODEX_BIN,
    ["app-server", "generate-json-schema", "--experimental", "--out", schemaDir],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );

  const clientRequest = JSON.parse(await readFile(join(schemaDir, "ClientRequest.json"), "utf8"));
  const encodedClientRequest = JSON.stringify(clientRequest);
  for (const method of REQUIRED_METHODS) {
    assert(encodedClientRequest.includes(`\"${method}\"`), `Generated schema is missing ${method}.`);
  }

  const resume = JSON.parse(await readFile(join(schemaDir, "v2", "ThreadResumeParams.json"), "utf8"));
  assert(resume.required?.includes("threadId"), "thread/resume no longer requires threadId.");

  const commandApproval = JSON.parse(
    await readFile(join(schemaDir, "CommandExecutionRequestApprovalParams.json"), "utf8"),
  );
  for (const field of ["threadId", "turnId", "itemId"]) {
    assert(commandApproval.required?.includes(field), `Command approval is missing ${field}.`);
  }

  const userInputRequest = JSON.parse(
    await readFile(join(schemaDir, "ToolRequestUserInputParams.json"), "utf8"),
  );
  for (const field of ["threadId", "turnId", "itemId"]) {
    assert(userInputRequest.required?.includes(field), `User input request is missing ${field}.`);
  }

  const completed = JSON.parse(
    await readFile(join(schemaDir, "v2", "TurnCompletedNotification.json"), "utf8"),
  );
  assert(completed.required?.includes("threadId"), "Turn completion is missing threadId.");
  assert(completed.required?.includes("turn"), "Turn completion is missing turn payload.");

  const threadRead = JSON.parse(
    await readFile(join(schemaDir, "v2", "ThreadReadResponse.json"), "utf8"),
  );
  const encodedThreadItem = JSON.stringify(threadRead);
  for (const field of ["senderThreadId", "receiverThreadIds", "agentsStates"]) {
    assert(encodedThreadItem.includes(`\"${field}\"`), `Collaboration item is missing ${field}.`);
  }

  return {
    requiredMethods: REQUIRED_METHODS.length,
    approvalCorrelationFields: true,
    collaborationCorrelationFields: true,
  };
}

async function metadataProbe({ workspace, sqliteHome, persistentThreadIds }) {
  let server = new AppServer({ cwd: workspace, sqliteHome });
  try {
    let startedAt = performance.now();
    await server.start();
    const firstInitializeMs = Math.round(performance.now() - startedAt);
    const account = await server.request("account/read", { refreshToken: false });
    const models = await server.request("model/list", { limit: 100, includeHidden: false });
    const initialIndex = await server.request("thread/list", {
      limit: 100,
      useStateDbOnly: true,
    });
    const preexistingThreadCount = Array.isArray(initialIndex?.data) ? initialIndex.data.length : 0;

    const started = await server.request(
      "thread/start",
      threadParams(workspace, { ephemeral: false }),
    );
    const threadId = started?.thread?.id;
    assert(typeof threadId === "string" && threadId.length > 0, "Persistent thread/start returned no ID.");
    assert(started.thread.ephemeral === false, "Persistent thread was unexpectedly ephemeral.");
    persistentThreadIds.add(threadId);

    await server.request("thread/inject_items", {
      threadId,
      items: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Xiao M0 persistence probe" }],
      }],
    });
    const readable = await server.request("thread/read", { threadId, includeTurns: false });
    assert(readable?.thread?.id === threadId, "thread/read returned a different probe thread.");
    assert(
      readable.thread.threadSource === "xiao-workbench-m0-probe",
      "App-server did not preserve the Xiao thread source tag.",
    );
    await server.stop();

    server = new AppServer({ cwd: workspace, sqliteHome });
    startedAt = performance.now();
    await server.start();
    const restartInitializeMs = Math.round(performance.now() - startedAt);
    startedAt = performance.now();
    const resumed = await server.request("thread/resume", {
      threadId,
      cwd: workspace,
      runtimeWorkspaceRoots: [workspace],
      approvalPolicy: "never",
      sandbox: "read-only",
      excludeTurns: false,
    });
    const resumeMs = Math.round(performance.now() - startedAt);
    assert(resumed?.thread?.id === threadId, "thread/resume returned a different thread.");
    assert(resumed.thread.ephemeral === false, "Resumed persistent thread became ephemeral.");
    assert(
      resumed.thread.threadSource === "xiao-workbench-m0-probe",
      "Resumed thread lost the Xiao source tag.",
    );
    await server.request("thread/delete", { threadId });
    persistentThreadIds.delete(threadId);
    const deletedThreadIsUnreadable = await server
      .request("thread/read", { threadId, includeTurns: false })
      .then(() => false)
      .catch(() => true);
    assert(deletedThreadIsUnreadable, "Deleted probe thread remained readable.");

    return {
      authenticated: account?.account != null,
      advertisedModels: Array.isArray(models?.data) ? models.data.length : 0,
      preexistingThreadsVisibleInStateDb: preexistingThreadCount,
      ownedThreadSourceTagPreserved: true,
      persistentResumeAcrossProcessRestart: true,
      timingMs: { firstInitializeMs, restartInitializeMs, resumeMs },
    };
  } finally {
    await server.stop();
  }
}

async function concurrentTurnsProbe(server, workspace) {
  const [startedA, startedB] = await Promise.all([
    server.request("thread/start", threadParams(workspace)),
    server.request("thread/start", threadParams(workspace)),
  ]);
  const threadA = startedA?.thread?.id;
  const threadB = startedB?.thread?.id;
  assert(threadA && threadB && threadA !== threadB, "Concurrent probe needs two distinct threads.");

  const sleepCommand = process.platform === "win32"
    ? 'powershell -NoProfile -Command "Start-Sleep -Seconds 3"'
    : "sleep 3";
  const firstTurnPromise = server.request("turn/start", {
    threadId: threadA,
    input: textInput(`Run exactly this command: ${sleepCommand}. Then reply exactly XIAO_PROBE_A.`),
    effort: "low",
  });
  const secondTurnPromise = server.request("turn/start", {
    threadId: threadB,
    input: textInput(`Run exactly this command: ${sleepCommand}. Then reply exactly XIAO_PROBE_B.`),
    effort: "low",
  });
  const [firstTurn, secondTurn] = await Promise.all([firstTurnPromise, secondTurnPromise]);
  const turnA = firstTurn?.turn?.id;
  const turnB = secondTurn?.turn?.id;
  assert(turnA && turnB && turnA !== turnB, "Concurrent turn/start returned invalid IDs.");

  const [doneA, doneB] = await Promise.all([
    server.waitFor((message) => terminalTurn(message, threadA, turnA), "first concurrent turn", TURN_TIMEOUT_MS),
    server.waitFor((message) => terminalTurn(message, threadB, turnB), "second concurrent turn", TURN_TIMEOUT_MS),
  ]);
  assert(doneA.message.params.turn.status === "completed", "First concurrent turn did not complete.");
  assert(doneB.message.params.turn.status === "completed", "Second concurrent turn did not complete.");

  const startedEventA = server.messages.find(
    ({ message }) => message.method === "turn/started" && message.params?.threadId === threadA && message.params?.turn?.id === turnA,
  );
  const startedEventB = server.messages.find(
    ({ message }) => message.method === "turn/started" && message.params?.threadId === threadB && message.params?.turn?.id === turnB,
  );
  assert(startedEventA && startedEventB, "Concurrent turn/started events were not correlated.");
  assert(
    Math.max(startedEventA.sequence, startedEventB.sequence) < Math.min(doneA.sequence, doneB.sequence),
    "The two turns were not active before the first completion.",
  );

  return { distinctThreads: true, correlatedEvents: true, overlapped: true };
}

async function interruptProbe(server, workspace) {
  const started = await server.request("thread/start", threadParams(workspace));
  const threadId = started?.thread?.id;
  assert(threadId, "Interrupt probe thread/start returned no ID.");

  const sleepCommand = process.platform === "win32"
    ? 'powershell -NoProfile -Command "Start-Sleep -Seconds 30"'
    : "sleep 30";
  const turnResponse = await server.request("turn/start", {
    threadId,
    input: textInput(`Run exactly this command and wait for it to finish: ${sleepCommand}`),
    effort: "low",
  });
  const turnId = turnResponse?.turn?.id;
  assert(turnId, "Interrupt probe turn/start returned no ID.");

  await server.waitFor(
    (message) =>
      message.method === "item/started" &&
      message.params?.threadId === threadId &&
      message.params?.turnId === turnId &&
      message.params?.item?.type === "commandExecution",
    "interrupt probe command execution",
    TURN_TIMEOUT_MS,
  );
  await server.request("turn/interrupt", { threadId, turnId });
  const terminal = await server.waitFor(
    (message) => terminalTurn(message, threadId, turnId),
    "interrupted turn completion",
    TURN_TIMEOUT_MS,
  );
  assert(terminal.message.params.turn.status === "interrupted", "Interrupted turn had a non-interrupted status.");

  return { interruptedDuringCommand: true, terminalStatus: "interrupted" };
}

const approvalDeclineResult = (method) => {
  if (method === "item/permissions/requestApproval") return { permissions: {}, scope: "turn" };
  return { decision: "decline" };
};

async function approvalRecoveryProbe({ workspace, sqliteHome, persistentThreadIds }) {
  let server = new AppServer({ cwd: workspace, sqliteHome });
  try {
    await server.start();
    const started = await server.request(
      "thread/start",
      threadParams(workspace, {
        ephemeral: false,
        approvalPolicy: "on-request",
        sandbox: "read-only",
        developerInstructions: "For this protocol probe, execute the exact command requested by the user.",
      }),
    );
    const threadId = started?.thread?.id;
    assert(threadId, "Approval recovery thread/start returned no ID.");
    persistentThreadIds.add(threadId);

    const mutationPath = join(workspace, "approval-probe.txt");
    const writeCommand = process.platform === "win32"
      ? 'powershell -NoProfile -Command "Set-Content -LiteralPath approval-probe.txt -Value x"'
      : "sh -c 'printf x > approval-probe.txt'";
    const turnResponse = await server.request("turn/start", {
      threadId,
      input: textInput(`Run exactly this command: ${writeCommand}`),
      effort: "low",
    });
    const turnId = turnResponse?.turn?.id;
    assert(turnId, "Approval recovery turn/start returned no ID.");

    const pending = await server.waitFor(
      (message) => {
        if (!APPROVAL_METHODS.has(message.method)) return false;
        return message.params?.threadId === threadId && message.params?.turnId === turnId;
      },
      "approval request",
      TURN_TIMEOUT_MS,
    );
    assert(typeof pending.message.params?.itemId === "string", "Approval request had no itemId.");
    assert(!existsSync(mutationPath), "Probe mutation happened before approval.");

    await server.stop();
    server = new AppServer({ cwd: workspace, sqliteHome });
    await server.start();
    const resumed = await server.request("thread/resume", {
      threadId,
      cwd: workspace,
      runtimeWorkspaceRoots: [workspace],
      approvalPolicy: "on-request",
      sandbox: "read-only",
      excludeTurns: false,
    });
    const resumedTurns = Array.isArray(resumed?.thread?.turns) ? resumed.thread.turns : [];
    const resumedTurn = resumedTurns.find((turn) => turn.id === turnId);

    const waitStart = server.sequence;
    const reemitted = await server
      .waitFor(
        (message) =>
          APPROVAL_METHODS.has(message.method) &&
          message.params?.threadId === threadId &&
          message.params?.turnId === turnId,
        "re-emitted approval request",
        5_000,
        waitStart,
      )
      .catch(() => null);

    if (reemitted) {
      server.reply(reemitted.message.id, approvalDeclineResult(reemitted.message.method));
      await server.waitFor(
        (message) => terminalTurn(message, threadId, turnId),
        "declined recovered approval turn",
        TURN_TIMEOUT_MS,
      );
    } else if (resumedTurn?.status === "inProgress") {
      await server.request("turn/interrupt", { threadId, turnId });
      await server.waitFor(
        (message) => terminalTurn(message, threadId, turnId),
        "interrupted recovered approval turn",
        TURN_TIMEOUT_MS,
      );
    }

    await delay(250);
    assert(!existsSync(mutationPath), "Pending approval was silently applied after restart.");
    await server.request("thread/delete", { threadId });
    persistentThreadIds.delete(threadId);

    return {
      requestReemitted: Boolean(reemitted),
      resumedTurnStatus: resumedTurn?.status || "notLoaded",
      silentMutation: false,
    };
  } finally {
    await server.stop();
  }
}

async function cleanupPersistentThreads({ workspace, sqliteHome, persistentThreadIds }) {
  if (!persistentThreadIds.size) return 0;
  const server = new AppServer({ cwd: workspace, sqliteHome });
  await server.start();
  let cleaned = 0;
  for (const threadId of [...persistentThreadIds]) {
    try {
      await server.request("thread/delete", { threadId });
      persistentThreadIds.delete(threadId);
      cleaned += 1;
    } catch {
      // Report the invariant failure after attempting every cleanup.
    }
  }
  await server.stop();
  assert(persistentThreadIds.size === 0, "Could not delete every persistent probe thread.");
  return cleaned;
}

const safeError = (error, root) => {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replaceAll(root, "<probe-temp>")
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "<redacted-email>")
    .slice(0, 2_000);
};

async function main() {
  const root = await mkdtemp(join(tmpdir(), "xiao-m0-probe-"));
  const workspace = join(root, "workspace");
  const sqliteHome = join(root, "codex-sqlite");
  const persistentThreadIds = new Set();
  const summary = {
    ok: false,
    cliVersion: execFileSync(CODEX_BIN, ["--version"], { encoding: "utf8", windowsHide: true }).trim(),
    schema: null,
    metadata: null,
    live: null,
    cleanup: { recoveredPersistentThreads: 0 },
  };

  await mkdir(workspace, { recursive: true });
  try {
    summary.schema = await generateAndCheckSchema(root);
    summary.metadata = await metadataProbe({ workspace, sqliteHome, persistentThreadIds });
    if (live) {
      assert(summary.metadata.authenticated, "Live probes require an authenticated Codex account.");
      const server = new AppServer({ cwd: workspace, sqliteHome });
      await server.start();
      try {
        summary.live = {
          concurrentTurns: await concurrentTurnsProbe(server, workspace),
          interruption: await interruptProbe(server, workspace),
          approvalRecovery: null,
        };
      } finally {
        await server.stop();
      }
      summary.live.approvalRecovery = await approvalRecoveryProbe({
        workspace,
        sqliteHome,
        persistentThreadIds,
      });
    }
    summary.ok = true;
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ ...summary, error: safeError(error, root) }, null, 2));
    process.exitCode = 1;
  } finally {
    try {
      summary.cleanup.recoveredPersistentThreads = await cleanupPersistentThreads({
        workspace,
        sqliteHome,
        persistentThreadIds,
      });
    } catch (error) {
      console.error(`Probe cleanup failed: ${safeError(error, root)}`);
      process.exitCode = 1;
    }
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  }
}

await main();
