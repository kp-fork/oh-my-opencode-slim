# Worktrees Skill

Manage Git worktrees as OMO safe isolated coding lanes for complex, risky, or parallel work.

## Overview

This bundled skill gives the `orchestrator` an opinionated safe orchestration
protocol for Git worktrees. It keeps isolated coding lanes under
`.slim/worktrees/<slug>/` and can track lane metadata in `.slim/worktrees.json`.

The point is not teaching Git commands. The skill standardizes how OMO plans
parallel work, assigns agents to isolated branches, asks before mutating Git
state, validates diffs, and cleans up safely.

## Installation

Bundled with `oh-my-opencode-slim` and installed automatically when bundled skills are enabled via the installer.
