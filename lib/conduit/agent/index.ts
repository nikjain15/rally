/**
 * @conduit/agent public surface.
 *
 * A pure, testable bounded agent loop built on the same injection discipline as
 * @conduit/inference: the model call and every tool effect are injected, so the
 * loop itself has no runtime globals and is exercised entirely with mocks in tests.
 *
 *   - runAgent(...)      the bounded reason-act loop (loop.ts).
 *   - Tool / ToolSpec    a validated, optionally side-effecting capability (tool.ts).
 *   - Skill              a declarative, intent-selected instruction module (skill.ts).
 *   - validate(...)      the JSON-schema argument validator the loop uses (schema.ts).
 *
 * No-authority invariant: a tool with `sideEffecting: true` is refused unless the
 * run is invoked with `allowSideEffects: true`. Default deny.
 */
export { runAgent } from "./loop";
export type {
  CallModel,
  ModelTurn,
  RunAgentInput,
  RunAgentResult,
  StepRecord,
  AgentError,
  AgentErrorKind,
} from "./loop";

export { toToolSpec } from "./tool";
export type { Tool, ToolSpec } from "./tool";

export { selectSkills } from "./skill";
export type { Skill, SkillContext } from "./skill";

export { validate } from "./schema";
export type { JsonSchema, JsonSchemaType, ValidationError, ValidationResult } from "./schema";
