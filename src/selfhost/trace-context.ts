const requestTraceParents = new WeakMap<Request, string>();

export function setSelfHostRequestTraceParent(request: Request, traceParent: string | undefined): void {
  if (traceParent) requestTraceParents.set(request, traceParent);
  else requestTraceParents.delete(request);
}

export function getSelfHostRequestTraceParent(request: Request): string | undefined {
  return requestTraceParents.get(request);
}

export function clearSelfHostRequestTraceParent(request: Request): void {
  requestTraceParents.delete(request);
}
