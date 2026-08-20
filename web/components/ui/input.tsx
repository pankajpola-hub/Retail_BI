import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * shadcn/ui-shaped Input/Select/Label (2026-08-20 UI foundation extension)
 * — the form-control counterpart to button.tsx/card.tsx from the
 * 2026-08-15 pass. Same reasoning as those: authored directly against the
 * app's EXISTING tokens (--line, --surface, --ink, --accent), no parallel
 * --primary/--input/etc. variable set introduced.
 *
 * Every form control across the app (Replenishment's filters/what-if
 * inputs, Targets' month/filter forms, the login form, etc.) had converged
 * on the same hand-typed class string — `min-h-[34px] border border-line
 * bg-surface px-2 py-1.5` or a close variant — independently, in each file.
 * That convergence is itself evidence a shared component was overdue: any
 * future visual change (focus ring, sizing, dark-mode token) would
 * otherwise mean editing N files identically and hoping none were missed.
 */
export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        "min-h-[34px] w-full rounded-md border border-line bg-surface px-2.5 py-1.5 text-[13px] text-ink placeholder:text-ink-3",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    />
  )
);
Input.displayName = "Input";

export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, children, ...props }, ref) => (
    <select
      ref={ref}
      className={cn(
        "min-h-[34px] w-full rounded-md border border-line bg-surface px-2.5 py-1.5 text-[13px] text-ink",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    >
      {children}
    </select>
  )
);
Select.displayName = "Select";

export const Label = React.forwardRef<HTMLLabelElement, React.LabelHTMLAttributes<HTMLLabelElement>>(
  ({ className, ...props }, ref) => (
    <label ref={ref} className={cn("text-[12px] font-medium text-ink-2", className)} {...props} />
  )
);
Label.displayName = "Label";
