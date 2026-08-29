"use client";

import * as React from "react";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { cn } from "@/lib/utils";

/**
 * shadcn/ui-shaped DropdownMenu (Radix primitives), added 2026-08-29 for the
 * three-way ThemeToggle. @radix-ui/react-dropdown-menu was already a declared
 * dependency but had no wrapper here yet — this is that wrapper, not a new
 * package.
 *
 * Visual language is copied from the two popovers this app already ships, so
 * the menu doesn't read as a foreign control bolted onto the header:
 *   - surface: FacetFilterBar's value dropdown — rounded-md, border-line,
 *     bg-surface, p-2, shadow-lg
 *   - items: that same dropdown's rows — rounded, px/py-1, text-[12px],
 *     hover:bg-surface-2
 *   - open/close animation: dialog.tsx's fade+zoom data-[state] classes
 *
 * forwardRef throughout for the same reason dialog.tsx documents: Radix's
 * Portal/Presence chain passes a ref down to the real DOM node, and a plain
 * function component throws "Function components cannot be given refs".
 */
export const DropdownMenu = DropdownMenuPrimitive.Root;
export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;

export const DropdownMenuContent = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content>
>(({ className, sideOffset = 6, ...props }, ref) => (
  <DropdownMenuPrimitive.Portal>
    <DropdownMenuPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        "z-50 min-w-[9rem] rounded-md border border-line bg-surface p-2 shadow-lg",
        "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
        className
      )}
      {...props}
    />
  </DropdownMenuPrimitive.Portal>
));
DropdownMenuContent.displayName = "DropdownMenuContent";

export const DropdownMenuLabel = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Label>
>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.Label
    ref={ref}
    className={cn("px-1 pb-1.5 text-[11px] font-medium text-ink-3", className)}
    {...props}
  />
));
DropdownMenuLabel.displayName = "DropdownMenuLabel";

export const DropdownMenuItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item>
>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.Item
    ref={ref}
    className={cn(
      // data-[highlighted] rather than :hover alone — Radix drives keyboard
      // navigation through that attribute, so arrow-key focus and mouse hover
      // land on the same visual state.
      "flex cursor-pointer select-none items-center gap-2 rounded px-1 py-1 text-[12px] text-ink-2 outline-none data-[highlighted]:bg-surface-2 data-[highlighted]:text-ink",
      className
    )}
    {...props}
  />
));
DropdownMenuItem.displayName = "DropdownMenuItem";
