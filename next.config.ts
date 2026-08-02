import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // @cohort/core is vendored inside the submission (vendor/cohort-core) as committed compiled
  // output, and depended on via `file:./vendor/cohort-core`. That keeps the submission fully
  // self-contained — a fresh clone of just this folder, and the isolated deploy repo, both
  // build with no pre-build and no sibling. The canonical source lives in submissions/
  // cohort-common; `npm run sync:core` regenerates the vendored copy (rally-tech-spec §3).

  // firebase-admin must NOT be bundled by Turbopack for the server routes: bundling rewrites
  // its deps' dynamic import() of the ESM-only `jose` (via jwks-rsa) into require(), which
  // throws ERR_REQUIRE_ESM at runtime on Vercel (verifyIdToken / all admin routes 500). Marking
  // it external loads it from node_modules with its dynamic imports intact. Local dev/emulator
  // never hit this because the emulator path skips jwks-rsa and dev doesn't bundle externals.
  serverExternalPackages: ["firebase-admin"],

  // Rally renders zero `next/image` components (the one avatar in components/rally-nav.tsx is a
  // plain <img> on a GitHub-hosted URL), so the Image Optimization endpoint at /_next/image is
  // dead surface that ships anyway. It is also the ONLY path by which `sharp`, and therefore
  // libvips, is ever loaded at runtime. sharp <0.35.0 carries GHSA-f88m-g3jw-g9cj (four inherited
  // libvips CVEs) and next 16.2.x pins `sharp: ^0.34.5`. Turning optimization off removes the
  // reachability instead of arguing about it: with `unoptimized`, /_next/image never decodes an
  // image and sharp is never required.
  //
  // Updated 2026-08-02: the version IS now fixed too. `overrides.sharp: ^0.35.0` in package.json
  // forces 0.35.3 past the range next declares, verified by a green build here and on Pulse,
  // which runs the same next 16.2.12. The allowlist entry that used to justify this line is gone
  // (see security/audit-allowlist.json, `resolved`). This setting stays: the endpoint is still
  // dead surface, and a fix plus removed reachability beats either alone.
  images: { unoptimized: true },
};

export default nextConfig;
