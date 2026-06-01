import { motion, useReducedMotion, type Variants } from "motion/react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Scroll-revealed wrapper. Animates once on first viewport entry.
 * Honors prefers-reduced-motion (snaps to final state).
 */
export function Reveal({
  children,
  className,
  delay = 0,
  y = 6,
  as: As = "div",
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
  y?: number;
  as?: "div" | "section" | "li" | "article";
}) {
  const reduce = useReducedMotion();
  const variants: Variants = {
    hidden: { opacity: 0, y: reduce ? 0 : y },
    show: {
      opacity: 1,
      y: 0,
      transition: { duration: 0.35, delay, ease: [0.22, 1, 0.36, 1] },
    },
  };
  const MotionTag = motion[As] as typeof motion.div;
  return (
    <MotionTag
      initial="hidden"
      whileInView="show"
      viewport={{ once: true, margin: "-10%" }}
      variants={variants}
      className={cn(className)}
    >
      {children}
    </MotionTag>
  );
}

/** Stagger container that reveals children one after another via Reveal. */
export function RevealGroup({
  children,
  className,
  stagger = 0.05,
}: {
  children: ReactNode;
  className?: string;
  stagger?: number;
}) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      initial="hidden"
      whileInView="show"
      viewport={{ once: true, margin: "-10%" }}
      transition={{ staggerChildren: reduce ? 0 : stagger }}
      className={cn(className)}
    >
      {children}
    </motion.div>
  );
}
