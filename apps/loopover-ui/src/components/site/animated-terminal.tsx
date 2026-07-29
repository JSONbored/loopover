import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

import { cn } from "@/lib/utils";

export interface TerminalScene {
  prompt: string;
  output: string;
}

const DEFAULT_SCENES: TerminalScene[] = [
  {
    prompt: "cat loop.ts",
    output: `while (true) {
  const work = await locate();   // discovery: issues, gaps, dups
  const pr   = await code(work); // contributor agent ships it
  const call = await review(pr); // maintainer agent decides
  await merge(call);             // or close — its call, logged
  await learn(call.outcome);     // every result tunes the loop
}
// this loop has no exit condition. neither did your backlog.`,
  },
  {
    prompt: "npx -y @loopover/mcp@latest login",
    output: "→ GitHub Device Flow opened… authorized as octocat",
  },
  {
    prompt: "loopover-mcp analyze-branch --login octocat --json",
    output: `{
  "lane": "maintainer",
  "branch_blockers": ["unsquashed-commits", "missing-issue-link"],
  "scoreability": {
    "current_gated":    0.42,
    "after_clean_gate": 0.71,
    "best_reasonable":  0.83
  },
  "next_actions": [ /* 3 ranked */ ]
}`,
  },
  {
    prompt: "loopover-mcp agent plan --login octocat --json",
    output: `{
  "plan": [
    { "action": "clean-open-prs",   "priority": 0.91 },
    { "action": "preflight-branch", "priority": 0.74 },
    { "action": "link-issue",       "priority": 0.61 }
  ],
  "ruleset_snapshot": "rs_a1f3c9e2",
  "signal_fidelity":  "ready"
}`,
  },
];

const TYPE_SPEED = 22;
const HOLD = 4200;

export function AnimatedTerminal({
  scenes = DEFAULT_SCENES,
  className,
}: {
  scenes?: TerminalScene[];
  className?: string;
}) {
  const reduce = useReducedMotion();
  const [sceneIdx, setSceneIdx] = useState(0);
  // The typing progress belongs to ONE scene, so it is stored under that scene's key (#9588). Advancing
  // the scene therefore resets the animation by derivation -- progress recorded for a previous scene can
  // never be read -- instead of two setState calls at the top of the effect. Reduced motion needs no
  // state at all: the finished frame is the pure value.
  const [progress, setProgress] = useState({ scene: 0, typed: "", showOutput: false });

  const scene = scenes[sceneIdx];
  const current =
    progress.scene === sceneIdx ? progress : { scene: sceneIdx, typed: "", showOutput: false };
  const typed = reduce ? scene.prompt : current.typed;
  const showOutput = reduce ? true : current.showOutput;

  useEffect(() => {
    if (reduce) return;
    let i = 0;
    const type = window.setInterval(() => {
      i += 1;
      setProgress({ scene: sceneIdx, typed: scene.prompt.slice(0, i), showOutput: false });
      if (i >= scene.prompt.length) {
        window.clearInterval(type);
        window.setTimeout(
          () => setProgress({ scene: sceneIdx, typed: scene.prompt, showOutput: true }),
          220,
        );
      }
    }, TYPE_SPEED);
    return () => window.clearInterval(type);
  }, [sceneIdx, scene.prompt, reduce]);

  useEffect(() => {
    if (!showOutput || reduce) return;
    const next = window.setTimeout(() => setSceneIdx((i) => (i + 1) % scenes.length), HOLD);
    return () => window.clearTimeout(next);
  }, [showOutput, scenes.length, reduce]);

  return (
    <div className={cn("rounded-token border border-border bg-background", className)}>
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
        <span className="font-mono text-token-2xs text-muted-foreground">~ loopover-mcp</span>
        <div className="flex items-center gap-1.5">
          {scenes.map((_, i) => (
            <span
              key={i}
              aria-hidden
              className={cn(
                "h-1 w-4 rounded-full transition-colors",
                i === sceneIdx ? "bg-coral" : "bg-foreground/25",
              )}
            />
          ))}
        </div>
      </div>
      <div className="px-4 pb-4 pt-3 font-mono text-token-xs leading-token-relaxed">
        <div className="flex items-baseline gap-2">
          <span className="text-mint">$</span>
          <span className="text-foreground">{typed}</span>
          {!showOutput && <Cursor />}
        </div>
        <div className="relative mt-3 min-h-[228px] sm:min-h-[208px]">
          <AnimatePresence mode="wait" initial={false}>
            {showOutput && (
              <motion.pre
                key={sceneIdx}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.18, ease: "easeOut" }}
                className="absolute inset-0 whitespace-pre-wrap text-muted-foreground"
              >
                {scene.output}
              </motion.pre>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}

function Cursor() {
  return (
    <motion.span
      aria-hidden
      animate={{ opacity: [1, 0, 1] }}
      transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
      className="inline-block h-4 w-[7px] translate-y-[2px] bg-mint/80"
    />
  );
}
