// Deterministic protocol/packaging check only. No model capability or benchmark claim.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const work = join(root, 'artifacts', `package-smoke-${Date.now()}`);
await mkdir(work, { recursive: true });
const tsx = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const cli = join(root, 'src', 'cli.ts');
const cleanEnv = { ...process.env };
for (const key of Object.keys(cleanEnv)) {
  if (/^(CLAW_|LLM_|OPENAI_|ANTHROPIC_|LITELLM_|BENCH_)/.test(key)) delete cleanEnv[key];
}
function run(args, env) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [tsx, cli, ...args], { cwd: work, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolveRun({ code, stdout, stderr }));
  });
}
const listing = await run(['sessions'], cleanEnv);
assert.equal(listing.code, 0, listing.stderr);
let calls = 0, toolResultReturned = false, requestFailure;
const server = createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'offline-smoke-model', object: 'model' }] })); return;
    }
    let raw = ''; for await (const part of req) raw += part;
    const body = JSON.parse(raw); calls += 1;
    assert.equal(body.model, 'offline-smoke-model');
    if (calls === 1) assert(body.tools.some(x => x.function.name === 'cog_write'));
    else toolResultReturned = body.messages.some(x => x.role === 'tool' && x.tool_call_id === 'offline-write');
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    if (calls === 1) {
      const args = JSON.stringify({ path: 'smoke-output.txt', content: 'offline tool execution works\n' });
      const cut = Math.floor(args.length / 2);
      emit({ tool_calls: [{ index: 0, id: 'offline-write', type: 'function', function: { name: 'cog_write', arguments: args.slice(0, cut) } }] });
      emit({ tool_calls: [{ index: 0, function: { arguments: args.slice(cut) } }] }, 'tool_calls');
    } else emit({ content: 'Offline packaging smoke completed; no model capability result.' }, 'stop');
    res.end('data: [DONE]\n\n');
  } catch (error) { requestFailure = error; res.writeHead(500); res.end('offline fixture failed'); }
});
await new Promise(resolveReady => server.listen(0, '127.0.0.1', resolveReady));
try {
  const env = { ...cleanEnv, CLAW_MODEL_CHANNELS: 'smoke', CLAW_MODEL_SMOKE_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`, CLAW_MODEL_SMOKE_API_KEY: 'offline-fixture-only' };
  const result = await run(['--workspace', work, '--model', 'smoke:offline-smoke-model', '--mode', 'auto', '--once', 'Perform the deterministic offline file-write fixture.'], env);
  if (requestFailure) throw requestFailure;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(calls, 2);
  assert.equal(toolResultReturned, true);
  assert.equal(await readFile(join(work, 'smoke-output.txt'), 'utf8'), 'offline tool execution works\n');
  console.log('PASS: CLI start, streamed argument fragments, real write, tool-result feedback.');
  console.log('Scope: mock model only; 0 paid calls; NOT an Agent benchmark result.');
} finally { await new Promise(resolveClosed => server.close(resolveClosed)); }
