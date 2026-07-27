/**
 * A Skill is a declarative capability module, not a hard-coded branch. It decides
 * whether it applies to the current run via `whenIntent(context)`, and if so the
 * loop injects its `instructions` into the system prompt. Skills therefore add
 * capability at runtime by shaping the model's guidance, never by adding imperative
 * control flow to the loop itself.
 */

export interface SkillContext {
  /** The user goal driving this run. */
  goal: string;
  /** Optional free-form context the caller supplies (tenant hints, prior state). */
  context?: string;
}

export interface Skill {
  id: string;
  /** Pure predicate over the run context. True = this skill's instructions load. */
  whenIntent(ctx: SkillContext): boolean;
  /** Guidance injected into the system prompt when the skill matches. */
  instructions: string;
}

/** Select the skills whose intent predicate matches, preserving input order. */
export function selectSkills(skills: readonly Skill[], ctx: SkillContext): Skill[] {
  const matched: Skill[] = [];
  for (const skill of skills) {
    let hit = false;
    try {
      hit = skill.whenIntent(ctx);
    } catch {
      // A misbehaving predicate never breaks the run; it simply does not match.
      hit = false;
    }
    if (hit) matched.push(skill);
  }
  return matched;
}
