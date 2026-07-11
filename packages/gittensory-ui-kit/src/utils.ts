import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Coarse relative-time label for "last refresh" style metadata (#2219). Clock skew or a
 * just-written timestamp can land marginally in the future — clamp to "just now" instead
 * of rendering a negative age.
 */
export function relativeTimeFromNow(timestampMs: number, nowMs: number): string {
  const deltaSeconds = Math.max(0, Math.floor((nowMs - timestampMs) / 1000));
  if (deltaSeconds < 60) return "just now";
  const minutes = Math.floor(deltaSeconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
