import os from "node:os";
import path from "node:path";
import { decryptSliceInput } from "../lib/slicing/input-envelope.ts";
import { loadSlicerProfileCatalog } from "../lib/slicing/profile-catalog.ts";
import { executeSignedSliceJob } from "../lib/slicing/slice-worker.ts";
import { signSliceWorkerResult, type SignedSliceJob } from "../lib/slicing/worker-contract.ts";

interface ClaimedJob {
  jobId: string;
  envelope: SignedSliceJob;
  input: {
    url: string;
    token: string;
    keyBase64: string;
    contentEncoding: "cqe-slice-aes-256-gcm-v1";
  };
}

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requiredArgument(name: string) {
  const value = argument(name);
  if (!value) throw new Error(`Missing required argument ${name}.`);
  return path.resolve(value);
}

function requiredEnvironment(name: "QUOTE_ENGINE_BASE_URL" | "SLICER_WORKER_TOKEN" | "SLICE_JOB_SIGNING_SECRET") {
  const value = process.env[name]?.trim();
  if (!value || Buffer.byteLength(value, "utf8") < (name === "QUOTE_ENGINE_BASE_URL" ? 1 : 32)) throw new Error(`${name} is required.`);
  return value;
}

function workerId() {
  const value = argument("--worker-id") ?? process.env.SLICER_WORKER_ID ?? `worker-${os.hostname()}`;
  const safe = value.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 100);
  if (safe.length < 3) throw new Error("The slicer worker identifier is invalid.");
  return safe;
}

async function apiRequest(baseUrl: URL, token: string, pathname: string, body: unknown) {
  return fetch(new URL(pathname, baseUrl), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function retryableFailure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return !/(not approved|invalid|does not match|exceeds|requires explicit|triangle limit|input hash|input length)/i.test(message);
}

function sameQuoteEngineOrigin(left: URL, right: URL) {
  if (left.origin === right.origin) return true;
  const localHosts = new Set(["localhost", "127.0.0.1"]);
  return localHosts.has(left.hostname)
    && localHosts.has(right.hostname)
    && left.protocol === right.protocol
    && left.port === right.port;
}

async function runOnce(context: {
  baseUrl: URL;
  token: string;
  signingSecret: string;
  id: string;
  engine: string;
  workRoot: string;
  catalog: Awaited<ReturnType<typeof loadSlicerProfileCatalog>>;
}) {
  const claimResponse = await apiRequest(context.baseUrl, context.token, "/api/slicer-worker/claim", { workerId: context.id });
  if (claimResponse.status === 204) return false;
  if (!claimResponse.ok) throw new Error(`The quote engine rejected the worker claim (${claimResponse.status}).`);
  const claimed = await claimResponse.json() as ClaimedJob;
  if (!claimed.jobId || !claimed.envelope || !claimed.input?.token || claimed.input.contentEncoding !== "cqe-slice-aes-256-gcm-v1") {
    throw new Error("The quote engine returned an invalid slicer-job claim.");
  }

  try {
    const inputUrl = new URL(claimed.input.url);
    if (!sameQuoteEngineOrigin(inputUrl, context.baseUrl)) throw new Error("The slicer input URL is outside the configured quote-engine origin.");
    const inputResponse = await fetch(inputUrl, {
      headers: {
        Accept: "application/octet-stream",
        "X-Slicer-Input-Token": claimed.input.token,
      },
    });
    if (!inputResponse.ok) throw new Error(`The encrypted slicer input could not be downloaded (${inputResponse.status}).`);
    const encrypted = Buffer.from(await inputResponse.arrayBuffer());
    const inputBuffer = decryptSliceInput(encrypted, Buffer.from(claimed.input.keyBase64, "base64"));
    const result = await executeSignedSliceJob({
      envelope: claimed.envelope,
      signingSecret: context.signingSecret,
      inputBuffer,
      context: {
        slicerExecutable: context.engine,
        workRoot: context.workRoot,
        profileCatalog: context.catalog,
      },
    });
    const signed = signSliceWorkerResult(result, context.signingSecret);
    const resultResponse = await apiRequest(context.baseUrl, context.token, `/api/slicer-worker/jobs/${claimed.jobId}/result`, {
      workerId: context.id,
      ...signed,
    });
    if (!resultResponse.ok) throw new Error(`The quote engine rejected the signed slicer result (${resultResponse.status}).`);
    process.stdout.write(`Completed slicer job ${claimed.jobId}.\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await apiRequest(context.baseUrl, context.token, `/api/slicer-worker/jobs/${claimed.jobId}/result`, {
      workerId: context.id,
      status: "failed",
      error: message.slice(0, 2000),
      retryable: retryableFailure(error),
    }).catch(() => undefined);
    throw error;
  }
  return true;
}

async function main() {
  const baseUrl = new URL(requiredEnvironment("QUOTE_ENGINE_BASE_URL"));
  if (baseUrl.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(baseUrl.hostname)) {
    throw new Error("QUOTE_ENGINE_BASE_URL must use HTTPS outside local development.");
  }
  const context = {
    baseUrl,
    token: requiredEnvironment("SLICER_WORKER_TOKEN"),
    signingSecret: requiredEnvironment("SLICE_JOB_SIGNING_SECRET"),
    id: workerId(),
    engine: requiredArgument("--engine"),
    workRoot: path.resolve(argument("--work-root") ?? path.join(os.tmpdir(), "carolina-slicer-worker")),
    catalog: await loadSlicerProfileCatalog(requiredArgument("--catalog")),
  };
  const watch = process.argv.includes("--watch");
  const pollMilliseconds = Math.max(2_000, Number(argument("--poll-ms") ?? 10_000));
  do {
    try {
      const worked = await runOnce(context);
      if (!watch) {
        if (!worked) process.stdout.write("No queued slicer jobs.\n");
        return;
      }
      if (worked) continue;
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      if (!watch) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMilliseconds));
  } while (watch);
}

main().catch(() => {
  process.exitCode = 1;
});
