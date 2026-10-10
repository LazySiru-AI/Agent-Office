import { defineConfig } from 'vitest/config';

/**
 * Runs each package's tests as its own project, so a failure names the package
 * it came from. `npm test` at the root drives this.
 *
 * This replaces `vitest.workspace.ts` and its `defineWorkspace([...])`, which
 * vitest 3 deprecates and vitest 4 removes outright. The move happened as part
 * of the AO-3 dependency upgrade rather than on its own: vitest had to go to 3
 * because vitest 2 pins `vite ^5`, and the live high-severity advisory
 * (GHSA-fx2h-pf6j-xcff, the `server.fs.deny` bypass on Windows) is only fixed
 * from `vite@6.4.3`. Doing the config migration in the same change keeps the
 * next major from being a second forced migration.
 *
 * `projects` takes the same glob the workspace file did, so which tests run and
 * how they are grouped is unchanged — this is a rename of the mechanism, not a
 * change to the suite.
 */
export default defineConfig({
  test: {
    projects: ['packages/*'],
  },
});
