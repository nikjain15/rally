/**
 * The app label map.
 *
 * A small, dependency-free lookup from an app id to its display name. The
 * gateway groups usage and suqs by app id and denormalizes the label onto each
 * record, so a consumer usually reads the label straight off the grouped
 * response. This map is the fallback for rendering an app id (for example on a
 * config surface that has no metered records yet) with its proper name.
 */
export const APP_LABELS: Record<string, string> = {
  founderfirst: "FounderFirst",
  roleos: "RoleOS",
  pulse: "Pulse",
  rally: "Rally",
};

/** Resolve an app id to its display label, falling back to the id itself. */
export function appLabel(app: string): string {
  return APP_LABELS[app] ?? app;
}
