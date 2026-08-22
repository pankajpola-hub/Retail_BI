import type { CurrentUser } from "@/lib/auth/roles";

export type VerticalKey = "ebo" | "ecomm" | "mbo" | "lfs";

export type VerticalScope = {
  key: VerticalKey;
  label: string;
  // Does this user hold the business_unit this vertical belongs to at all.
  granted: boolean;
  // Does a real data pipeline exist for this vertical yet — independent of
  // `granted`. MBO/LFS share EBO's "retail" business_unit grant (no
  // dedicated grant of their own exists yet) but have no pipeline, which is
  // what the UI renders as disabled-with-status rather than absent.
  pipelineConnected: boolean;
};

export type ViewScope = {
  verticals: VerticalScope[];
};

// MBO/LFS are gated on the same "retail" business_unit as EBO (see the
// warehouse/godown project memory — all four verticals share one physical
// warehouse) since neither has a business_unit or role of its own yet.
// `pipelineConnected: false` is the only thing that needs to flip, in this
// one place, once either gets a real data pipeline.
export function resolveViewScope(user: Pick<CurrentUser, "businessUnits">): ViewScope {
  const hasRetail = user.businessUnits.includes("retail");
  const hasEcomm = user.businessUnits.includes("ecomm");

  return {
    verticals: [
      { key: "ebo", label: "EBO", granted: hasRetail, pipelineConnected: true },
      { key: "ecomm", label: "ECOM", granted: hasEcomm, pipelineConnected: true },
      { key: "mbo", label: "MBO", granted: hasRetail, pipelineConnected: false },
      { key: "lfs", label: "LFS", granted: hasRetail, pipelineConnected: false },
    ],
  };
}
