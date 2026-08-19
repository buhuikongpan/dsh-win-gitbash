import { existsSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { TOOL_ABORTED, defineTool } from '@deepseek-ai/dsh-tools'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import {
  ESCALATION_TARGETS,
  SandboxUnavailableError,
  approveEscalation,
  canonicalPath,
  escalationHintMarker,
  sandboxDenialMarker,
  validateEscalationArgs,
} from '@deepseek-ai/dsh-sandbox'
import { parseExitStatus } from '@deepseek-ai/dsh-shell'
import { clampTimeout, deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'

export const name = 'tool-gitbash'
export const inject = ['tools', 'subprocess', 'systemPrompt', 'shellEnv']

/** Runtime configuration schema (mirrors the shell tool family). */
export const Config = z.object({
  enableRunInBackground: z.boolean().default(true),
  bashPath: z.string().required(false),
})

const GIT_BASH_CANDIDATES = [
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
]

/** Well-known installs (Program Files, scoop) plus PATH entries. */
function gitBashCandidates() {
  const userProfile = process.env.USERPROFILE ?? ''
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
  const scoopRoot = process.env.SCOOP ?? (userProfile.length > 0 ? join(userProfile, 'scoop') : '')
  const candidates = [...GIT_BASH_CANDIDATES]
  if (scoopRoot.length > 0) candidates.push(join(scoopRoot, 'apps', 'git', 'current', 'bin', 'bash.exe'))
  for (const entry of (process.env.PATH ?? '').split(';')) {
    const trimmed = entry.trim().replace(/^"|"$/g, '')
    if (trimmed.length === 0 || trimmed.toLowerCase().startsWith(systemRoot.toLowerCase())) continue
    candidates.push(join(trimmed, 'bash.exe'))
  }
  return candidates
}
const DEFAULT_TIMEOUT_MS = 120000
const MAX_TIMEOUT_MS = 600000
const GRACE_MS = 3000
const MAX_OUTPUT_BYTES = 64 * 1024
const MAX_SPILL_BYTES = 64 * 1024 * 1024
const ENV_OVERRIDES = { NO_COLOR: '1', TERM: 'dumb', PAGER: 'cat', GIT_PAGER: 'cat' }
const TIMEOUT_CODE = 'GITBASH_TIMEOUT'

function resolveGitBash(configured) {
  if (configured !== undefined && configured.length > 0) return configured
  const candidates = gitBashCandidates()
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error(`tool-gitbash: Git Bash not found — checked ${candidates.join(', ')}`)
}

/** Structured runner-failure classification (mirror of the pwsh-sandbox dialect). */
function classifyRunnerFailure(exitCode, stderr, rules) {
  if (exitCode === null || exitCode === 0) return undefined
  const lines = stderr.split(/\r?\n/)
  for (const rule of rules) {
    if (rule.allowedExitCodes !== undefined && !rule.allowedExitCodes.includes(exitCode)) continue
    const informationalLines = new Set((rule.informationalLines ?? []).map((line) => line.toLowerCase()))
    const fatalSignatures = rule.fatalSignatures.filter((signature) => signature.trim().length > 0).map((signature) => signature.toLowerCase())
    for (const line of lines) {
      const lowered = line.toLowerCase()
      if (informationalLines.has(lowered)) continue
      if (fatalSignatures.some((signature) => lowered.includes(signature))) return { detail: line }
    }
  }
  return undefined
}

/** Denial classification against the selected backend's stderr dialect. */
function matchesSignature(exitCode, stderr, signatures) {
  if (exitCode === null || exitCode === 0) return false
  const lowered = stderr.toLowerCase()
  return signatures.some((signature) => lowered.includes(signature.toLowerCase()))
}

function validateArgs(args) {
  if (typeof args.command !== 'string' || args.command.trim().length === 0) throw new Error('invalid command: expected a non-empty string')
  if (typeof args.description !== 'string' || args.description.trim().length === 0) throw new Error('invalid description: expected a non-empty string')
  if (args.timeoutMs !== undefined && (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) throw new Error(`invalid timeoutMs: expected a positive number, got ${JSON.stringify(args.timeoutMs)}`)
  validateEscalationArgs(args.sandbox_permissions, args.justification)
}

/** Resolve the sandbox root first; otherwise the canonical session cwd (mirror of the bash tool). */
function resolveWorkdir(modelWorkdir, exec, policyWorkspaceRoot) {
  const headerCwd = exec.agent?.session.header.cwd
  const sessionCwd = policyWorkspaceRoot ?? (headerCwd === undefined ? undefined : canonicalPath(headerCwd))
  if (modelWorkdir === undefined) return sessionCwd
  if (sessionCwd !== undefined && !isAbsolute(modelWorkdir)) return resolve(sessionCwd, modelWorkdir)
  return modelWorkdir
}

function streamText(output) {
  if (!output.truncated) return output.text
  return `${output.text}\n[output truncated; full output: ${output.spillPath ?? '(unavailable)'}]`
}

function renderResult(result, escalationModes) {
  const out = streamText(result.stdout)
  const err = streamText(result.stderr)
  let body = out
  if (err.length > 0) {
    if (body.length > 0 && !body.endsWith('\n')) body += '\n'
    body += `[stderr]\n${err}`
  }
  if (body.length === 0) body = '(no output)'
  const markers = []
  if (result.sandbox?.denied) {
    markers.push(sandboxDenialMarker(result.sandbox.mode))
    if (escalationModes.length > 0) markers.push(escalationHintMarker('command'))
  }
  if (result.timedOut) markers.push(`[timed out after ${result.timeoutMs}ms]`)
  if (result.signal !== null) markers.push(`[killed by signal: ${result.signal}]`)
  else if (result.exitCode !== 0) markers.push(`[exit code: ${result.exitCode}]`)
  if (markers.length === 0) return body
  if (!body.endsWith('\n')) body += '\n'
  return body + markers.join('\n')
}

function renderProcessRead(read, sandbox, escalationModes) {
  const notices = []
  if (read.lossy) {
    const paths = [read.stdoutSpillPath, read.stderrSpillPath].filter((path) => path !== undefined)
    notices.push(`[some output was dropped from memory; full output: ${paths.length > 0 ? paths.join(', ') : '(unavailable)'}]`)
  }
  if (sandbox?.runnerFailed) notices.push(`[sandbox: the sandbox runner itself failed under ${sandbox.mode} mode — the command did not run; this is a sandbox problem, not a command failure]`)
  else if (sandbox?.denied) {
    notices.push(sandboxDenialMarker(sandbox.mode))
    if (escalationModes.length > 0) notices.push(escalationHintMarker('command'))
  }
  if (notices.length === 0) return read.delta
  return `${read.delta}${read.delta.length > 0 && !read.delta.endsWith('\n') ? '\n' : ''}${notices.join('\n')}`
}

function gitBashDescription(backgroundEnabled, escalationModes) {
  const base = 'Execute a Git Bash command (`bash -c`) and return its stdout/stderr. Each call runs in a fresh shell: no state (cwd, variables, functions) persists between calls — pass `workdir` instead of using `cd`. Paths accept native Windows form (`C:\\...`) and Git Bash form (`/c/...`). Non-zero exits are reported as `[exit code: N]`. Current harness environment facts are exposed through managed `$DSH_*` variables; inspect them when needed. Commands may run under a file sandbox; a blocked file operation is reported as `[sandbox: file access denied under <mode> mode]` — a policy denial, not a bug in the command; do not retry another way. Long output is truncated to its tail; the full output is saved to a file whose path is reported when available. On Windows a force-killed command settles as `[exit code: 1]` without a signal marker — treat it as an interruption, not a command failure. ' + (backgroundEnabled ? 'Set `run_in_background: true` for long-running commands: the call returns a job id immediately; read its output with `job_output` and stop it with `job_kill`.' : 'Background execution is not available; long-running commands must finish within the timeout.')
  if (escalationModes.length === 0) return base
  return base + ' Attempting a command the sandbox may deny is safe and expected: run it and read the marker rather than assuming the denial. When a command is denied and a wider mode would let it succeed, escalate immediately in the same turn — the one sanctioned exception to a denial: retry the exact same command once with `sandbox_permissions` (the narrowest wider mode that suffices) plus a one-sentence `justification`. Do not detour through chat to ask permission first — the approval prompt raised by that retry is how the user consents. If the session states approval prompts are disabled, there is no exception: a denial is final — do not set `sandbox_permissions`. Never escalate speculatively: ground the request in a real denial — normally the one this command just hit; escalating up front is fine only when this session already denied the same access. A rejected escalation is final for that command — stop and explain, never work around it — but it does not forbid attempting or escalating other commands later.'
}

export function apply(ctx, config = {}) {
  const backgroundEnabled = config.enableRunInBackground ?? true
  const bash = resolveGitBash(config.bashPath)
  const sandboxProvider = ctx.get('sandbox')
  const sandboxPolicyService = ctx.get('sandboxPolicy')
  // Mirror the pwsh tool's confined-detection story: a configured default
  // sandbox mode (pwsh reads ctx.shell.sandboxMode; gitbash reads the
  // sandbox-policy's defaultMode) means this composition confines commands.
  const defaultMode = sandboxPolicyService?.defaultMode
  const confining = defaultMode !== undefined
  if (confining && sandboxProvider === undefined) throw new Error('tool-gitbash: a sandbox policy is mounted but ctx.sandbox is missing')
  const escalationModes = confining ? [...ESCALATION_TARGETS] : []

  /** Resolve a sandbox-escalation request through `ctx.approval` BEFORE anything executes (mirror of the pwsh tool). */
  const approveGitBashEscalation = (mode, justification, exec, standingPolicy) => {
    if (escalationModes.length === 0) throw new Error('sandbox_permissions is not available in this composition (no sandboxing executor to escalate)')
    const effectiveMode = standingPolicy.mode
    return approveEscalation(
      { requestedMode: mode, justification, effectiveMode, subject: 'command' },
      { approver: ctx.get('approval'), agent: exec.agent, callId: exec.callId, toolName: 'gitbash', signal: exec.signal },
    )
  }

  /** Apply implementation-owned defaults and caps to one execution request. */
  function resolveRequest(request) {
    return {
      command: request.command,
      workdir: request.workdir ?? process.cwd(),
      timeoutMs: clampTimeout(request.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, 'gitbash: request.timeoutMs'),
      stdoutMaxBytes: MAX_OUTPUT_BYTES,
      ...(request.signal ? { signal: request.signal } : {}),
      ...(request.dshEnv !== undefined ? { dshEnv: request.dshEnv } : {}),
      ...(request.sandboxPolicy !== undefined ? { sandboxPolicy: request.sandboxPolicy } : {}),
    }
  }

  /** Map a resolved request plus explicit argv onto a fully-specified subprocess spawn. */
  function spawnSpec(spec, argv, signal) {
    const collect = (maxBytes) => ({ maxBytes, spill: { maxBytes: MAX_SPILL_BYTES } })
    return {
      argv,
      cwd: spec.workdir,
      stdio: {
        stdin: 'ignore',
        stdout: collect(spec.stdoutMaxBytes),
        stderr: collect(MAX_OUTPUT_BYTES),
      },
      graceMs: GRACE_MS,
      ...(signal !== undefined ? { signal } : {}),
      env: {
        ...ENV_OVERRIDES,
        ...spec.env,
        ...spec.dshEnv,
      },
    }
  }

  function finalOutput(reader) {
    if (reader === undefined) return { text: '', truncated: false }
    const read = reader.readFrom(0)
    return {
      text: read.text,
      truncated: read.lossy,
      ...(read.spillPath !== undefined ? { spillPath: read.spillPath } : {}),
    }
  }

  /** Run one command in the foreground; nonzero exits and kills resolve, infra failures reject. */
  async function runForeground(request, argv, sandboxFacts) {
    const spec = resolveRequest(request)
    const d = deadline(spec.signal, spec.timeoutMs, TIMEOUT_CODE)
    try {
      const handle = ctx.subprocess.spawn(spawnSpec(spec, argv, d.signal))
      const outcome = await handle.done
      const timedOut = timeoutOf(d.signal, TIMEOUT_CODE) !== undefined
      const aborted = d.signal.aborted && !timedOut
      const stdout = finalOutput(handle.collected.stdout)
      const stderr = finalOutput(handle.collected.stderr)
      let sandbox
      if (sandboxFacts !== undefined) {
        if (sandboxFacts.mode === 'danger-full-access') {
          sandbox = { mode: sandboxFacts.mode, denied: false }
        } else {
          const runnerFailure = classifyRunnerFailure(outcome.exitCode, stderr.text, sandboxFacts.runnerFailureRules)
          if (runnerFailure !== undefined) throw new SandboxUnavailableError(sandboxFacts.mode, runnerFailure.detail)
          sandbox = {
            mode: sandboxFacts.mode,
            denied: matchesSignature(outcome.exitCode, stderr.text, sandboxFacts.denialSignatures),
            enforcement: sandboxFacts.enforcement,
          }
        }
      }
      return {
        exitCode: outcome.exitCode,
        signal: outcome.signal,
        timedOut,
        aborted,
        timeoutMs: spec.timeoutMs,
        stdout,
        stderr,
        ...(sandbox !== undefined ? { sandbox } : {}),
      }
    } finally {
      d[Symbol.dispose]?.()
    }
  }

  /** Start one background process; no timeout applies; done never rejects. */
  function startBashProcess(request, argv, sandboxFacts) {
    const spec = resolveRequest(request)
    const handle = ctx.subprocess.spawn(spawnSpec(spec, argv, undefined))
    const collected = handle.collected
    let stdoutOffset = 0
    let stderrOffset = 0
    let spawnFailureNote
    const consumeSpawnFailure = () => {
      const note = spawnFailureNote ?? ''
      spawnFailureNote = undefined
      return note
    }
    const proc = {
      status: 'running',
      exitCode: null,
      signal: null,
      done: handle.done.then((outcome) => {
        if (proc.status === 'running') proc.status = 'completed'
        proc.exitCode = outcome.exitCode
        proc.signal = outcome.signal
        if (sandboxFacts !== undefined && sandboxFacts.mode !== 'danger-full-access') {
          const stderrText = collected.stderr.readFrom(0).text
          const runnerFailure = classifyRunnerFailure(outcome.exitCode, stderrText, sandboxFacts.runnerFailureRules)
          proc.sandbox = {
            mode: sandboxFacts.mode,
            denied: runnerFailure === undefined && matchesSignature(outcome.exitCode, stderrText, sandboxFacts.denialSignatures),
            enforcement: sandboxFacts.enforcement,
            ...(runnerFailure !== undefined ? { runnerFailed: true } : {}),
          }
        }
      }, (error) => {
        proc.status = 'killed'
        spawnFailureNote = `spawn failed: ${error?.message ?? String(error)}`
      }),
      readOutput() {
        const out = collected.stdout.readFrom(stdoutOffset)
        const err = collected.stderr.readFrom(stderrOffset)
        stdoutOffset = out.nextOffset
        stderrOffset = err.nextOffset
        const errText = err.text.length > 0 ? err.text : consumeSpawnFailure()
        const separator = out.text.length > 0 && !out.text.endsWith('\n') ? '\n' : ''
        return {
          delta: out.text + (errText.length > 0 ? `${separator}[stderr]\n${errText}` : ''),
          lossy: out.lossy || err.lossy,
          ...(out.spillPath !== undefined ? { stdoutSpillPath: out.spillPath } : {}),
          ...(err.spillPath !== undefined ? { stderrSpillPath: err.spillPath } : {}),
        }
      },
      kill() {
        if (proc.status !== 'running') return false
        proc.status = 'killed'
        handle.terminate()
        return true
      },
    }
    return proc
  }

  function processOutcome(proc) {
    if (proc.status === 'killed') {
      return { status: 'killed', detail: proc.signal !== null ? `signal: ${proc.signal}` : 'killed before exit' }
    }
    return { status: 'completed', detail: `exit code: ${proc.exitCode ?? 0}` }
  }

  function canonicalResult(result) {
    const output = (stream) => ({
      text: stream.text,
      truncated: stream.truncated,
      ...(stream.spillPath !== undefined ? { spillPath: stream.spillPath } : {}),
    })
    return {
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      aborted: result.aborted,
      timeoutMs: result.timeoutMs,
      stdout: output(result.stdout),
      stderr: output(result.stderr),
      ...(result.sandbox !== undefined ? {
        sandbox: {
          mode: result.sandbox.mode,
          denied: result.sandbox.denied,
          ...(result.sandbox.enforcement !== undefined ? { enforcement: result.sandbox.enforcement } : {}),
          ...(result.sandbox.runnerFailed !== undefined ? { runnerFailed: result.sandbox.runnerFailed } : {}),
        },
      } : {}),
    }
  }

  async function execute(args, exec) {
    validateArgs(args)
    const jobs = ctx.get('jobs')
    const standingPolicy = confining ? sandboxPolicyService.resolve(exec.agent === undefined ? {} : { session: exec.agent.session }) : undefined
    const approvedMode = args.sandbox_permissions !== undefined && args.justification !== undefined
      ? await approveGitBashEscalation(args.sandbox_permissions, args.justification, exec, standingPolicy)
      : undefined
    const policy = approvedMode === undefined ? standingPolicy : { ...standingPolicy, mode: approvedMode }
    const cwd = resolveWorkdir(args.workdir, exec, policy?.workspaceRoot)
    if (cwd === undefined) throw new Error('gitbash: cannot resolve a working directory for this session')
    const dshEnv = ctx.shellEnv.collect(exec)
    const request = {
      command: args.command,
      workdir: cwd,
      ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
      dshEnv,
      ...(policy !== undefined ? { sandboxPolicy: policy } : {}),
    }

    let argv = [bash, '-c', args.command]
    let sandboxFacts
    if (policy !== undefined && policy.mode !== 'danger-full-access') {
      const confined = sandboxProvider.confine(argv, {
        mode: policy.mode,
        workspaceRoot: policy.workspaceRoot,
        ...(policy.sessionId !== undefined ? { sessionId: policy.sessionId } : {}),
      })
      argv = confined.argv
      sandboxFacts = {
        mode: policy.mode,
        enforcement: confined.enforcement,
        denialSignatures: confined.denialSignatures,
        runnerFailureRules: confined.runnerFailureRules,
      }
    } else if (policy !== undefined) {
      sandboxFacts = { mode: policy.mode }
    }

    if (args.run_in_background === true) {
      if (!backgroundEnabled) throw new Error('run_in_background is disabled for this deployment (enableRunInBackground: false)')
      if (jobs === undefined) throw new Error('background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs')
      if (exec.signal.aborted) {
        const error = new HarnessError('tool call aborted', TOOL_ABORTED)
        error.name = 'AbortError'
        throw error
      }
      return {
        kind: 'background',
        jobId: jobs.start({
          kind: 'gitbash',
          label: args.command,
          ...(exec.agent ? { owner: exec.agent } : {}),
          run: () => {
            const proc = startBashProcess(request, argv, sandboxFacts)
            return {
              cancel: () => void proc.kill(),
              done: proc.done.then(() => processOutcome(proc)),
              readOutput: () => renderProcessRead(proc.readOutput(), proc.sandbox, escalationModes),
            }
          },
        }),
      }
    }

    const result = await runForeground({ ...request, signal: exec.signal }, argv, sandboxFacts)
    if (result.aborted) {
      const error = new HarnessError('tool call aborted', TOOL_ABORTED)
      error.name = 'AbortError'
      throw error
    }
    return { kind: 'foreground', ...canonicalResult(result) }
  }

  ctx.systemPrompt.section({
    name: 'tool:gitbash',
    order: 105,
    text: 'Non-zero exits are reported as `[exit code: N]` markers; investigate failures before moving on. On Windows a killed process settles as `[exit code: 1]` without a signal marker; treat a bare exit 1 after an interruption as a termination, not a command failure.',
  })

  ctx.tools.register(defineTool({
    name: 'gitbash',
    description: gitBashDescription(backgroundEnabled, escalationModes),
    parameters: {
      command: { type: 'string', required: true, description: 'The Git Bash command to execute.' },
      description: { type: 'string', required: true, description: 'Clear, concise description of what this command does in active voice, 5-10 words (shown in the UI). Examples: "ls" → "List files in current directory"; "git status" → "Show working tree status"; "npm install" → "Install package dependencies".' },
      timeoutMs: { type: 'number', description: 'Timeout in milliseconds. The executor applies its configured default and cap, and kills the command on expiry.' },
      workdir: { type: 'string', description: 'Working directory for this command. Defaults to the session workspace; a relative path is resolved against it.' },
      ...(backgroundEnabled ? {
        run_in_background: { type: 'boolean', description: 'Run in the background and return a job id immediately (collect with job_output, stop with job_kill). No timeout applies.' },
      } : {}),
      ...(escalationModes.length > 0 ? {
        sandbox_permissions: { type: 'string', enum: escalationModes, description: 'The wider sandbox mode this command needs. Only valid as a one-shot retry of a command the sandbox just denied; requires justification and user approval.' },
        justification: { type: 'string', description: 'Required with sandbox_permissions: one sentence for the user explaining why this exact command needs the wider access.' },
      } : {}),
    },
    output: {
      schema: {
        oneOf: [{
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: { type: 'string', required: true, const: 'background' },
            jobId: { type: 'string', required: true },
          },
        }, {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: { type: 'string', required: true, const: 'foreground' },
            exitCode: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] },
            signal: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
            timedOut: { type: 'boolean', required: true },
            aborted: { type: 'boolean', required: true },
            timeoutMs: { type: 'number', required: true },
            stdout: { type: 'object', additionalProperties: false, required: true, properties: { text: { type: 'string', required: true }, truncated: { type: 'boolean', required: true }, spillPath: { type: 'string' } } },
            stderr: { type: 'object', additionalProperties: false, required: true, properties: { text: { type: 'string', required: true }, truncated: { type: 'boolean', required: true }, spillPath: { type: 'string' } } },
            sandbox: { type: 'object', additionalProperties: false, properties: { mode: { type: 'string', required: true }, denied: { type: 'boolean', required: true }, enforcement: { type: 'string' }, runnerFailed: { type: 'boolean' } } },
          },
        }],
      },
      render(_args, value) {
        return [{ type: 'text', text: value.kind === 'background' ? `started background job ${value.jobId}` : renderResult(value, escalationModes) }]
      },
    },
    execute,
    presentCall(args) {
      if (args.run_in_background === true) {
        return {
          card: 'generic',
          title: args.command,
          kind: 'execute',
          rawInput: args.command,
          content: [{ type: 'text', text: args.description }],
        }
      }
      return {
        card: 'terminal',
        title: args.command,
        description: args.description,
        ...(args.workdir !== undefined ? { cwd: args.workdir } : {}),
      }
    },
    presentResult(args, result) {
      const block = result.content.length === 1 ? result.content[0] : undefined
      if (block === undefined || block.type !== 'text') return undefined
      const raw = block.text
      if ((typeof args === 'object' && args !== null && args.run_in_background === true) || result.isError) {
        return { card: 'generic', content: [{ type: 'text', text: `\`\`\`console\n${raw.replace(/\n+$/, '')}\n\`\`\`` }] }
      }
      const { body, ...exit } = parseExitStatus(raw)
      return { card: 'terminal', output: body, ...exit }
    },
  }))
}
