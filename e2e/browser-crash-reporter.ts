import type { FullResult, Reporter, TestCase, TestResult } from '@playwright/test/reporter';

/**
 * Process-level browser crash accounting for #8447.
 *
 * `attachBrowserLossDiagnostics` (#6501) is attached per spec and only ever
 * sees the specs that opt in — 2 of the 13 ci-smoke files, neither of which
 * crashed — so a browser that dies anywhere else leaves no trace. The
 * `chrome-headless-shell` SIGTRAP that reddens these jobs is a *process*
 * event, so it is counted here at run scope instead.
 *
 * The count is deliberately independent of the job outcome. With `retries: 1`
 * a single crash is absorbed and the run still reports green or `flaky`; that
 * laundering is why 38 of 50 recorded crashes sat inside passing jobs and went
 * unread from #5685 until #8447. This reporter states the count on every run,
 * so a swallowed crash cannot pass as a clean one.
 *
 * Scope note: this is the in-process half. The `variant-smoke-shards` job also
 * greps its teed debug log from the shell (`test.yml`), which covers the same
 * crashes for that job; this reporter is what covers every other Playwright
 * job — variant-smoke-pro-webmcp, prehydration, pro-cls, pro-hero, webmcp and
 * the visual workflows — plus every local invocation that opts in.
 */

/**
 * Playwright records each browser process exit at `pw:browser` verbosity as
 * `<process did exit: exitCode=<code>, signal=<name>>`, with `null` for
 * whichever half did not apply. The shape is pinned by the fixture in
 * `tests/ci-workflow-coverage.test.mts`.
 */
const PROCESS_EXIT = /<process did exit: exitCode=(\S+?), signal=(\S+?)>/g;

/**
 * Debug output is colorised unless `DEBUG_COLORS=0` is set, and only the
 * ci-smoke job sets it. Strip the escapes so the summary and the JSON artifact
 * stay readable and greppable in every other job — an unstripped record still
 * parses, but it lands in the artifact as control characters.
 */
const ANSI = /\u001B\[[0-9;]*m/g;

const stripAnsi = (line: string): string => line.replace(ANSI, '').trim();

export interface CrashRecord {
  /** Signal name, or `null` when the process exited on its own. */
  readonly signal: string;
  readonly exitCode: string;
  /** The verbatim pw:browser line, so the report stays citable. */
  readonly raw: string;
}

export interface CrashTally {
  readonly crashes: readonly CrashRecord[];
  /** Orderly `exitCode=0, signal=null` shutdowns, i.e. `browser.close()`. */
  readonly cleanExits: number;
  /** Lines naming -- or fragmenting -- a process exit in a shape this parser did not expect. */
  readonly unparsed: readonly string[];
}

/**
 * Count browser process exits in a `DEBUG=pw:browser` stream.
 *
 * A non-zero exit with no signal is counted as a crash too: the browser died
 * without naming a signal, which is how an OOM kill reads in this log. Only
 * `exitCode=0, signal=null` is an orderly shutdown.
 *
 * Anything exit-related that does not parse is returned in `unparsed` instead
 * of being dropped, including a fragment that lost the phrase to a chunk
 * boundary -- the filter accepts a bare `exitCode=` assignment as well.
 */
export function tallyBrowserProcessExits(log: string): CrashTally {
  const crashes: CrashRecord[] = [];
  const unparsed: string[] = [];
  let cleanExits = 0;

  for (const line of log.split('\n')) {
    // The phrase, or the `exitCode=` assignment behind it: unattributed output
    // is merged chunk by chunk and never rejoined, so a boundary inside the
    // phrase leaves neither half holding all of it. Between the two markers
    // there are only the two characters `: `, so whatever the split point, one
    // half matches here and the fragment reaches `unparsed` instead of
    // vanishing. A stray `exitCode=` line that is not an exit record costs one
    // unparsed entry, which is the conservative direction for a count that
    // warns when it may under-report.
    if (!line.includes('process did exit') && !line.includes('exitCode=')) continue;
    // A line can carry more than one exit, so consume every match and use the
    // match count -- not a substring test -- to decide whether this is a shape
    // the parser understands.
    const matches = [...line.matchAll(PROCESS_EXIT)];
    if (matches.length === 0) {
      unparsed.push(stripAnsi(line));
      continue;
    }
    for (const [, exitCode = '', signal = ''] of matches) {
      if (signal === 'null' && exitCode === '0') {
        cleanExits += 1;
        continue;
      }
      crashes.push({ signal, exitCode, raw: stripAnsi(line) });
    }
  }

  return { crashes, cleanExits, unparsed };
}

/**
 * One summary line per run, always emitted.
 *
 * The `[crash-report]` prefix sits alongside the `[browser-loss]` prefix
 * already grepped out of these logs, so existing tooling keeps working.
 */
export function crashSummaryLine(tally: CrashTally): string {
  const { crashes } = tally;
  if (crashes.length === 0) {
    return '[crash-report] 0 browser crash(es): no chrome-headless-shell process exited on a signal';
  }
  const byCause = new Map<string, number>();
  for (const crash of crashes) {
    const key = crash.signal === 'null' ? `exitCode=${crash.exitCode}` : crash.signal;
    byCause.set(key, (byCause.get(key) ?? 0) + 1);
  }
  const breakdown = [...byCause].map(([key, count]) => `${key}x${count}`).join(', ');
  return `[crash-report] ${crashes.length} browser crash(es): ${breakdown}`;
}

/** Flatten a tally back into the sample lines the step summary quotes. */
export function crashSampleLines(tally: CrashTally, limit = 50): {
  lines: string[];
  omitted: number;
} {
  return {
    lines: tally.crashes.slice(0, limit).map((crash) => crash.raw),
    omitted: Math.max(0, tally.crashes.length - limit),
  };
}

/**
 * Collect `pw:browser` process exits from every worker and print one
 * run-global total, whatever the run's outcome.
 *
 * Active in CI by default, and locally behind `WM_CRASH_REPORT=1` so a
 * developer iterating does not pay for log capture they did not ask for.
 */
export default class BrowserCrashReporter implements Reporter {
  private readonly enabled =
    process.env.WM_CRASH_REPORT === '1' || Boolean(process.env.CI);

  /**
   * Workers only emit `pw:browser` lines when that channel is in `DEBUG`; the
   * runner forwards worker stdio to reporters regardless. Only
   * `variant-smoke-shards` sets `DEBUG=pw:browser` today, so requesting the
   * channel from the reporter is what makes the count exist everywhere instead
   * of only in that one job.
   *
   * `pw:browser` is the cheap tier: measured at roughly 1 MB per shard with no
   * measurable runtime cost, unlike `pw:channel`, which was priced at +75%
   * runtime and dropped for that reason (see
   * docs/solutions/conventions/a-lost-browser-is-already-legible-in-the-playwright-artifact.md).
   */
  constructor() {
    if (!this.enabled) return;
    const current = process.env.DEBUG?.trim();
    if (!current) {
      process.env.DEBUG = 'pw:browser';
      return;
    }
    if (!current.split(',').some((channel) => channel.trim() === 'pw:browser')) {
      process.env.DEBUG = `${current},pw:browser`;
    }
  }

  private readonly crashes: CrashRecord[] = [];
  private unparsed: string[] = [];
  private cleanExits = 0;

  /**
   * Debug output arrives as arbitrary chunks, so a process-exit record can be
   * split across two calls. Hold the trailing partial line and prepend it to
   * the next chunk; without this the record most likely to be cut in half is
   * the one that matters.
   *
   * One buffer per worker and stream, not one shared buffer: the runner
   * multiplexes every worker's stdout and stderr into these two callbacks, so
   * chunks from different workers -- and from the two streams -- interleave
   * freely. A single shared buffer prepends one worker's fragment to another
   * worker's line, and the merged line then matches only the complete record,
   * silently dropping the fragment's crash without even landing it in
   * `unparsed` -- exactly the under-report this reporter exists to prevent.
   *
   * Reassembly is only ever within one worker's own stream, so it needs a
   * worker to key on; `absorb` covers the case where Playwright hands the
   * callback no `result` at all.
   */
  private readonly pending = new Map<string, string>();

  onStdOut(chunk: string | Buffer, _test: void | TestCase, result: void | TestResult): void {
    if (this.enabled) this.absorb(chunk.toString(), result, 'stdout');
  }

  onStdErr(chunk: string | Buffer, _test: void | TestCase, result: void | TestResult): void {
    if (this.enabled) this.absorb(chunk.toString(), result, 'stderr');
  }

  /**
   * `result` is absent whenever the runner cannot attribute a chunk to a
   * running test: a worker sitting idle between tests, a worker whose
   * worker-scoped browser is closing during teardown -- the point at which its
   * exit record is emitted -- or any output from a worker that has already
   * failed. The runner drops the identity on those paths (`handleOutput` in
   * `runner/index.js` returns the bare chunk when `worker.didFail()` or when
   * nothing is currently running).
   *
   * With no `result` there is no `workerIndex`, so two workers' chunks would
   * share one key -- the very aliasing the per-worker buffers exist to avoid.
   * Joining them is worse than not joining them: a fragment from worker A
   * prepended to worker B's complete record matches only B's record, so A's
   * crash is counted nowhere, not even in `unparsed`. Merging each unattributed
   * chunk as it arrives keeps B's count honest and turns A's fragment into an
   * `unparsed` line, which the console notice and the step summary both report
   * as a count that may under-report, and which the JSON artifact keeps
   * verbatim. A visible gap beats a silent one.
   */
  private absorb(chunk: string, result: void | TestResult, stream: 'stdout' | 'stderr'): void {
    if (!result) {
      this.merge(chunk);
      return;
    }

    const key = `${result.workerIndex}:${stream}`;
    const combined = (this.pending.get(key) ?? '') + chunk;
    const lastNewline = combined.lastIndexOf('\n');
    if (lastNewline === -1) {
      this.pending.set(key, combined);
      return;
    }
    const remainder = combined.slice(lastNewline + 1);
    // Delete rather than store the empty string, so a long run with many
    // workers and streams cannot grow the map without bound.
    if (remainder) this.pending.set(key, remainder);
    else this.pending.delete(key);
    this.merge(combined.slice(0, lastNewline));
  }

  private merge(text: string): void {
    const { crashes, cleanExits, unparsed } = tallyBrowserProcessExits(text);
    this.crashes.push(...crashes);
    this.cleanExits += cleanExits;
    this.unparsed.push(...unparsed);
  }

  async onEnd(result: FullResult): Promise<void> {
    if (!this.enabled) return;
    // Flush every buffer, not just one: a worker that never emitted a trailing
    // newline still holds a complete record that the tally must see.
    for (const remainder of this.pending.values()) {
      if (remainder) this.merge(remainder);
    }
    this.pending.clear();

    const tally: CrashTally = {
      crashes: this.crashes,
      cleanExits: this.cleanExits,
      unparsed: this.unparsed,
    };

    // Always print, including at zero. A summary that appears only on crashes
    // is indistinguishable from a run whose capture silently broke.
    console.log(crashSummaryLine(tally));
    console.log(`[crash-report] clean browser exits: ${tally.cleanExits}; run outcome: ${result.status}`);
    if (tally.unparsed.length > 0) {
      // A process-exit line this parser could not read is the one way the count
      // can under-report, so it is named rather than swallowed: an unnoticed
      // parse miss would look exactly like a crash-free run.
      console.log(
        `[crash-report] ${tally.unparsed.length} process-exit line(s) in an unrecognised shape; the count above may under-report`,
      );
    }
    if (tally.crashes.length > 0 && result.status === 'passed') {
      // The point of #8447: name the swallow rather than let a green tick
      // imply the browser never died.
      console.log(
        `[crash-report] this run reported "${result.status}" with ${tally.crashes.length} crash(es): `
        + 'a retry or teardown let the run pass anyway, so green here does not mean crash-free',
      );
    }

    if (process.env.GITHUB_STEP_SUMMARY) await this.writeArtifacts(tally, result);
  }

  /**
   * Persist the count where the job already writes artifacts. `test-results/`
   * is uploaded by every Playwright job in `test.yml` and `e2e-visual.yml`, and
   * the step summary is the same channel #8449 uses, so this adds no plumbing.
   */
  private async writeArtifacts(tally: CrashTally, result: FullResult): Promise<void> {
    const stepSummaryPath = process.env.GITHUB_STEP_SUMMARY;
    if (!stepSummaryPath) return;

    const lines = [
      '',
      `### Browser crashes, ${process.env.WM_CRASH_REPORT_LABEL ?? 'e2e run'}`,
      '',
      crashSummaryLine(tally),
      '',
      `Clean browser exits: ${tally.cleanExits}`,
      `Run outcome: ${result.status}`,
      '',
    ];
    if (tally.unparsed.length > 0) {
      lines.push(
        `${tally.unparsed.length} process-exit line(s) in an unrecognised shape; the count above may under-report:`,
        '',
        '```',
        ...tally.unparsed.slice(0, 10),
        '```',
        '',
      );
    }
    if (tally.crashes.length > 0) {
      const { lines: samples, omitted } = crashSampleLines(tally);
      lines.push('```', ...samples, '```', '');
      if (omitted > 0) {
        // Bounded because GITHUB_STEP_SUMMARY caps at 1 MiB and an oversized
        // write is dropped whole, which would lose the count above too. Name
        // the cut: a silent truncation reads as if these were all of them.
        lines.push(`Showing the first 50. The other ${omitted} are in the uploaded artifact.`, '');
      }
    }

    const { appendFile, mkdir, writeFile } = await import('node:fs/promises');
    await appendFile(stepSummaryPath, `${lines.join('\n')}\n`).catch(() => {});
    await mkdir('test-results', { recursive: true }).catch(() => {});
    await writeFile(
      'test-results/browser-crash-report.json',
      `${JSON.stringify({ ...tally, runStatus: result.status }, null, 2)}\n`,
    ).catch(() => {
      // An unwritable artifact directory must not turn a report into a failure.
    });
  }
}
