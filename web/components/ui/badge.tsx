import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/** shadcn/ui-shaped Badge, variants mapped onto the app's existing semantic soft-color tokens (good/warn/crit already used for exactly this purpose elsewhere — see WorkspaceGridClient's cost pill). */
const badgeVariants = cva(
  "inline-flex items-center rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide",
  {
    variants: {
      variant: {
        default: "bg-accent-soft text-accent-ink",
        secondary: "bg-surface-2 text-ink-2",
        good: "bg-good-soft text-good",
        warn: "bg-warn-soft text-warn",
        destructive: "bg-crit-soft text-crit",
        outline: "border border-line text-ink-2",
      },
    },
    defaultVariants: { variant: "default" },
  }
);

export type BadgeProps = React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>;

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant, className }))} {...props} />;
}
