import type { ReactNode } from "react";

import { DocsPrevNext } from "./docs-nav";
import { ReadingProgress } from "./reading-progress";

export function DocsPage({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <>
      <ReadingProgress />
      <article className="prose-docs">
        <header className="mb-10">
          {eyebrow && <div className="text-token-xs text-muted-foreground">{eyebrow}</div>}
          <h1 className="mt-2 text-token-2xl font-medium tracking-tight text-foreground">
            {title}
          </h1>
          {description && (
            <p className="mt-3 max-w-2xl text-token-sm text-muted-foreground">{description}</p>
          )}
        </header>
        <div className="space-y-5 text-token-base leading-token-relaxed text-foreground/85 [&_h2]:mt-10 [&_h2]:mb-2 [&_h2]:text-token-lg [&_h2]:font-medium [&_h2]:text-foreground [&_h3]:mt-6 [&_h3]:mb-1.5 [&_h3]:text-token-sm [&_h3]:font-medium [&_h3]:text-foreground [&_p]:text-muted-foreground [&_strong]:text-foreground [&_ul]:list-disc [&_ul]:pl-6 [&_ul]:text-muted-foreground [&_ol]:list-decimal [&_ol]:pl-6 [&_ol]:text-muted-foreground [&_li]:mt-1 [&_p>a]:text-mint [&_li>a]:text-mint [&_p>a:hover]:underline [&_li>a:hover]:underline [&_code]:rounded [&_code]:bg-accent/40 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-token-xs">
          {children}
        </div>
        <DocsPrevNext />
      </article>
    </>
  );
}
