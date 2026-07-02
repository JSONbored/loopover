const WORKFLOW_PATH = /^\.github\/workflows\/.+\.ya?ml$/;

/** GitHub workflow paths are case-insensitive; normalize separators before matching. */
export function isWorkflowPath(path: string): boolean {
  return WORKFLOW_PATH.test(path.replace(/\\/g, "/").toLowerCase());
}
