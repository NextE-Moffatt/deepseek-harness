#!/usr/bin/env node
/**
 * The `dsh-kb-mcp` bin: boot the minimal server composition (system-prompt /
 * tools / kb-core / kb-mcp-server) and serve the workspace's reference pool
 * over stdio until the client disconnects. Deployment configuration comes
 * from `KB_MCP_*` environment variables; a missing `KB_MCP_ROOT` exits with a
 * loud error. This file is thin glue excluded from the coverage gate; the
 * composition it boots is covered by the loader-composition spec and the
 * built-bin e2e.
 */

import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import KbCore from '@deepseek-ai/dsh-kb-core'
import { apply, inject, name, type KbMcpServerConfig } from './index.ts'

/** Read one optional environment variable as a number. */
function envNumber(variable: string): number | undefined {
  const value = process.env[variable]
  return value === undefined || value === '' ? undefined : Number(value)
}

/** Read one optional environment variable as a string. */
function envString(variable: string): string | undefined {
  const value = process.env[variable]
  return value === undefined || value === '' ? undefined : value
}

const root = envString('KB_MCP_ROOT')
if (root === undefined) {
  console.error('dsh-kb-mcp: KB_MCP_ROOT is required — the workspace root whose reference pool this server exposes')
  process.exit(1)
}

const cardsPath = envString('KB_MCP_CARDS_PATH')
const indexPath = envString('KB_MCP_INDEX_PATH')
const heatPath = envString('KB_MCP_HEAT_PATH')
const recapPath = envString('KB_MCP_RECAP_PATH')
const teamRepoPath = envString('KB_MCP_TEAM_REPO_PATH')
const cardTtlDays = envNumber('KB_MCP_CARD_TTL_DAYS')
const freshnessWarningDays = envNumber('KB_MCP_FRESHNESS_WARNING_DAYS')
const kbConfig: Record<string, string | number> = {}
if (cardsPath !== undefined) kbConfig.cardsPath = cardsPath
if (indexPath !== undefined) kbConfig.indexPath = indexPath
if (heatPath !== undefined) kbConfig.heatPath = heatPath
if (recapPath !== undefined) kbConfig.recapPath = recapPath
if (teamRepoPath !== undefined) kbConfig.teamRepoPath = teamRepoPath
if (cardTtlDays !== undefined) kbConfig.cardTtlDays = cardTtlDays
if (freshnessWarningDays !== undefined) kbConfig.freshnessWarningDays = freshnessWarningDays

const serverConfig: KbMcpServerConfig = { root }

const ctx = new Context()
try {
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(KbCore, kbConfig)
  await ctx.plugin({ name, inject, apply }, serverConfig)
} catch (error) {
  console.error('dsh-kb-mcp: failed to boot the server composition: %o', error)
  process.exit(1)
}

// The stdio transport keeps the process alive while the client holds stdin
// open; an EOF (client disconnect) disposes the composition and exits.
process.stdin.on('end', () => { void ctx.fiber.dispose() })
process.stdin.on('error', (error) => {
  console.error('dsh-kb-mcp: stdin error: %o', error)
  process.exit(1)
})
