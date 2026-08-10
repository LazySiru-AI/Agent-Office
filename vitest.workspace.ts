import { defineWorkspace } from 'vitest/config';

/**
 * Runs each package's tests as its own project, so a failure names the package
 * it came from. `npm test` at the root drives this.
 */
export default defineWorkspace(['packages/*']);
