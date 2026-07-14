// #542 public/private boundary primitive — extracted to gittensory-engine (#4883) as confirmed-pure,
// dependency-free string logic. This module is now a re-export shim over the canonical engine source so every
// existing `../signals/redaction` import path stays unchanged. See the engine file for the full rationale.
export * from "../../packages/gittensory-engine/src/signals/redaction";
