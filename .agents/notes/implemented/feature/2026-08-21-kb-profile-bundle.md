# Agent Note: Installable knowledge-base Profile Bundle

Status: implemented

English | [中文](2026-08-21-kb-profile-bundle.zh.md)

## Problem

The knowledge-base capability has three independently owned runtime packages, but an operator who wants the complete Web experience otherwise has to reproduce their composition and dependency closure in every profile. The team repository path cannot be portable because it names deployment-owned storage.

## Decision

`@deepseek-ai/dsh-kb` is an optional Profile Bundle under `packages/bundle/kb`. Its manifest points `dsh.bundle.patch` at a committed patch that mounts `kb-core`, `kb-web`, and `ui-kb-workbench`. The bundle declares those packages as runtime dependencies, so one installation carries the complete Web knowledge-base composition.

The patch supplies an empty `packs` list and deliberately omits `teamRepoPath` and `teamWriteApproval`. A deployment that enables a team library replaces the complete `kb-core` row in a later profile, home, or invocation patch and states its host path and policy there. Headless deployments mount `kb-core` directly because the bundle always includes the Web Host and Client consumers.

## Distribution contract

The bundle directory is a standalone GitHub-install target: its `package.json` and `cordis.patch.yml` are committed together, and its manifest repository directory identifies the same path. Package tests parse the patch with the real Loader schema and pin the three rows and dependency names.

## Alternatives considered

**Add the knowledge packages to the shipped Web bundle.** This would make the feature part of every Web installation and violate its opt-in composition requirement.

**Put the team repository path in the bundle.** A bundle cannot select a valid shared work tree or approval policy across hosts, and a fallback path would silently bind the wrong storage.

**Publish only `kb-core`.** That supports headless tools but does not deliver the governance workbench users expect from the marketplace entry.

## Consequences

Operators can install one package for the complete Web experience, while personal and team storage remain governed by existing `kb-core` semantics. The bundle adds one distribution package and documentation pair. Deployments must still provide a later patch for a team library, and the bundle is not the minimal headless composition.
