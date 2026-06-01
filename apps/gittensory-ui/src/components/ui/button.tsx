import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex min-w-0 items-center justify-center gap-2 whitespace-normal break-words rounded-token text-center text-token-sm font-medium leading-token-snug cursor-pointer transition-all duration-150 motion-reduce:transition-none motion-reduce:active:scale-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background active:scale-[0.99] disabled:pointer-events-none disabled:opacity-60 disabled:cursor-not-allowed [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        accent: "bg-primary text-primary-foreground hover:brightness-110",
        destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        outline:
          "border-hairline bg-transparent text-foreground hover:bg-muted hover:border-strong",
        secondary: "bg-muted text-foreground hover:bg-muted/70 border-hairline",
        ghost: "text-foreground hover:bg-muted",
        link: "h-auto p-0 text-foreground underline-offset-4 hover:underline active:scale-100",
      },
      size: {
        default: "min-h-9 px-4 py-2",
        sm: "min-h-8 px-3 py-1.5 text-token-xs",
        lg: "min-h-11 px-8 py-2.5",
        icon: "h-9 w-9 shrink-0 whitespace-nowrap p-0",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
