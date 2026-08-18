/**
 * The git operations the team library needs: work-tree assertion, working-tree
 * status, staging, and committing. kb never clones, fetches, or pushes — the
 * team's own git workflow owns those. The git executable is injected so unit
 * tests exercise every branch without a real repository; production uses
 * `execFile` against the configured work tree.
 * @module @deepseek-ai/dsh-kb-core/gitops
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

/** One git invocation outcome. */
export interface GitRunResult {
  /** Standard output, decoded as UTF-8. */
  stdout: string
  /** Standard error, decoded as UTF-8. */
  stderr: string
}

/** An injectable git runner: one call per `git <args>` invocation. */
export type GitExec = (args: readonly string[]) => Promise<GitRunResult>

const execFileAsync = promisify(execFile)

/** Run git through `execFile` in the work tree, converting failures to errors with stderr. */
function gitExec(dir: string): GitExec {
  return async (args) => {
    try {
      const { stdout, stderr } = await execFileAsync('git', [...args], { cwd: dir, encoding: 'utf8' })
      return { stdout, stderr }
    } catch (error) {
      const cause = error as { stderr?: unknown; message?: string }
      const detail = typeof cause.stderr === 'string' && cause.stderr.trim() !== '' ? cause.stderr.trim() : cause.message
      throw new Error(`git ${args.join(' ')} failed: ${detail}`)
    }
  }
}

/**
 * The kb git surface over one team work tree. Methods fail loud on non-zero
 * git exits; `assertWorkTree` is the one-shot "is this a work tree" probe.
 */
export class GitRunner {
  /** The git invoker, replaceable in tests. */
  readonly run: GitExec

  /**
   * @param dir - the team work tree directory.
   * @param run - optional injected git invoker (unit tests); defaults to real `execFile`.
   */
  constructor(readonly dir: string, run?: GitExec) {
    this.run = run ?? gitExec(dir)
  }

  /**
   * Assert the directory is inside a git work tree, failing loud otherwise.
   * @returns this runner, for chaining.
   */
  async assertWorkTree(): Promise<GitRunner> {
    const { stdout } = await this.run(['rev-parse', '--is-inside-work-tree'])
    if (stdout.trim() !== 'true') {
      throw new Error(`team library at "${this.dir}" is not a git work tree`)
    }
    return this
  }

  /**
   * The porcelain working-tree status: changed, added, and untracked entries
   * relative to HEAD, one line each. Empty when the tree is clean.
   * @returns the non-empty porcelain lines.
   */
  async status(): Promise<string[]> {
    const { stdout } = await this.run(['status', '--porcelain'])
    return stdout.split('\n').map(line => line.trimEnd()).filter(line => line !== '')
  }

  /**
   * Stage every working-tree change. The team repository is dedicated to
   * `cards/` and `docs/`, so a whole-tree `git add -A` is the kb-owned scope.
   */
  async stage(): Promise<void> {
    await this.run(['add', '-A'])
  }

  /**
   * Commit the staged changes with the caller-supplied message.
   * @param message - the commit message (non-empty, validated by the caller).
   * @returns the raw commit output.
   */
  async commit(message: string): Promise<string> {
    const { stdout } = await this.run(['commit', '-m', message])
    return stdout
  }

  /**
   * The recent commit subjects, for acceptance evidence.
   * @param limit - the number of commits to show.
   * @returns the `git log --oneline` lines.
   */
  async log(limit: number): Promise<string[]> {
    const { stdout } = await this.run(['log', `-n ${limit}`, '--oneline'])
    return stdout.split('\n').map(line => line.trimEnd()).filter(line => line !== '')
  }
}
