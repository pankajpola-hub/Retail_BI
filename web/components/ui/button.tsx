import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * shadcn/ui-shaped Button (Radix Slot + cva variants) — 2026-08-15 UI
 * foundation pass. Deliberately does NOT introduce shadcn's usual
 * --primary/--secondary/--destructive CSS variable set: this app already
 * has a mature, actively-used token system (--accent, --surface-2, --crit,
 * etc. in globals.css) and duplicating it under different names would be a
 * second, driftable source of truth for the same colors. Every variant
 * below is authored directly against the EXISTING app tokens instead.
 */
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-[13px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "bg-accent text-white shadow-sm hover:brightness-105",
        secondary: "bg-surface-2 text-ink-2 hover:bg-line-soft",
        outline: "border border-line bg-surface text-ink-2 hover:bg-surface-2",
        ghost: "text-ink-2 hover:bg-surface-2",
        destructive: "bg-crit text-white shadow-sm hover:brightness-105",
        link: "text-accent underline-offset-4 hover:underline",
      },
      size: {
        default: "min-h-[38px] px-4",
        sm: "min-h-[32px] px-3 text-[12px]",
        lg: "min-h-[44px] px-6 text-[14px]",
        icon: "h-8 w-8 shrink-0",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  }
);

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants> & { asChild?: boolean };

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />;
  }
);
Button.displayName = "Button";
