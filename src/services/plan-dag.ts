// #783 multi-step action DAG.
//
// The implementation moved to `@loopover/engine` in #9537. It had to: the stdio MCP server
// (packages/loopover-mcp) needs the same state machine, resolves `@loopover/engine` through the
// PUBLISHED package, and could not import the Worker's own `src/` -- so it carried a hand-written
// untyped copy of `buildPlanDag`/`validatePlanDag`/`nextReadySteps` that a fix to this file would
// silently miss. One implementation now, in the package both servers can reach.
//
// This module stays as the Worker's import path so nothing else had to move.
export {
  buildPlanDag,
  validatePlanDag,
  nextReadySteps,
  markStepRunning,
  applyStepResult,
  planProgress,
  type PlanDag,
  type PlanStep,
  type PlanStepStatus,
  type PlanOverallStatus,
  type PlanProgress,
} from "@loopover/engine";
