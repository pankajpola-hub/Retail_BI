// =============================================================================
// One-off / re-runnable Permit.io policy sync — mirrors lib/auth/roles.ts's
// PAGE_ROLE_DEFAULTS into Permit.io, so the two stay readable side by side
// instead of the policy only existing in Permit's dashboard.
// =============================================================================
// NOT part of the Next.js app — run manually with `node scripts/permit-seed-policy.js`
// from web/ whenever PAGE_ROLE_DEFAULTS changes (or a new page/role is added).
// Idempotent: creates a resource/role if missing, otherwise updates it in
// place — safe to re-run.
//
// Scope, deliberately: this seeds ONE page per resource (matching today's
// PAGE_ROLE_DEFAULTS 1:1) so Permit.io's policy starts as a drop-in mirror of
// what requirePageAccess() already enforces in Postgres/app code — nothing
// new yet. business_unit (0061_business_unit.sql) is NOT modeled here: that
// stays a Postgres-side check via core.fn_user_business_units(), not
// duplicated into Permit.io, to avoid two systems disagreeing about the same
// rule. Per-user overrides (core.user_page_overrides) also stay in Postgres
// for now — only the ROLE defaults move to Permit.io in this first pass.

const { Permit } = require("permitio");

const PERMIT_API_KEY = process.env.PERMIT_API_KEY;
if (!PERMIT_API_KEY) {
  console.error("Set PERMIT_API_KEY (see web/.env.local) before running this script.");
  process.exit(1);
}

const permit = new Permit({
  token: PERMIT_API_KEY,
  pdp: "https://cloudpdp.api.permit.io",
});

// Mirrors web/lib/auth/roles.ts's PAGE_KEYS / PAGE_LABELS exactly.
const PAGES = [
  { key: "network", name: "Network" },
  { key: "stock-details", name: "Stock Details" },
  { key: "replenishment", name: "Replenishment" },
  { key: "footfall", name: "Footfall" },
  { key: "targets", name: "Targets" },
  { key: "users", name: "Users" },
  { key: "integrations", name: "Integrations" },
  { key: "data-upload", name: "Data Upload" },
  { key: "workspace", name: "Workspace" },
  { key: "configurations", name: "Configurations" },
  { key: "ecomm", name: "Ecomm" },
];

// Mirrors web/lib/auth/roles.ts's PAGE_ROLE_DEFAULTS exactly.
const PAGE_ROLE_DEFAULTS = {
  network: ["ho_admin", "regional_manager", "super_admin", "ebo_manager", "marketing"],
  "stock-details": ["ho_admin", "regional_manager", "super_admin", "ebo_manager", "marketing"],
  replenishment: ["ho_admin", "regional_manager", "super_admin", "ebo_manager", "marketing"],
  footfall: ["ebo_manager", "ho_admin", "super_admin"],
  targets: ["ho_admin", "regional_manager", "super_admin", "ebo_manager"],
  users: ["super_admin"],
  integrations: ["super_admin"],
  "data-upload": ["ho_admin", "super_admin"],
  workspace: ["ho_admin", "regional_manager", "super_admin", "ebo_manager", "marketing"],
  configurations: ["super_admin"],
  ecomm: ["ho_admin", "super_admin", "marketing"],
};

const ROLES = [
  { key: "super_admin", name: "Super Admin" },
  { key: "ho_admin", name: "HO Admin" },
  { key: "regional_manager", name: "Regional Manager" },
  { key: "ebo_manager", name: "EBO Manager" },
  { key: "marketing", name: "Marketing" },
];

async function upsertResource(page) {
  try {
    await permit.api.resources.create({
      key: page.key,
      name: page.name,
      actions: { view: { name: "View" } },
    });
    console.log(`  resource created: ${page.key}`);
  } catch (err) {
    if (String(err.message || err).includes("already exists") || err.response?.status === 409) {
      console.log(`  resource exists:  ${page.key}`);
    } else {
      throw err;
    }
  }
}

async function upsertRole(role) {
  const permissions = PAGES.filter((p) => PAGE_ROLE_DEFAULTS[p.key].includes(role.key)).map((p) => `${p.key}:view`);
  try {
    await permit.api.roles.create({
      key: role.key,
      name: role.name,
      permissions,
    });
    console.log(`  role created: ${role.key} -> [${permissions.join(", ")}]`);
  } catch (err) {
    if (String(err.message || err).includes("already exists") || err.response?.status === 409) {
      await permit.api.roles.update(role.key, { permissions });
      console.log(`  role updated: ${role.key} -> [${permissions.join(", ")}]`);
    } else {
      throw err;
    }
  }
}

(async () => {
  console.log("Resources (pages):");
  for (const page of PAGES) await upsertResource(page);

  console.log("Roles:");
  for (const role of ROLES) await upsertRole(role);

  console.log("Done.");
})().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
