import type { StepName } from "./state.ts";

/**
 * The house-stack accounts (decisions 33, 43). Setup only prints what to create and reads the token;
 * it never calls a provider (validation is a later step). Provider consoles change: if a narrower scope
 * than the one described exists when you create the token, choose it.
 */
export interface TokenSpec {
  key: string;
  /** Shown in the hidden prompt. */
  label: string;
  /** production tokens are broker-only (decision 12): they can reach production or delete data. */
  tier: "preview" | "production";
  /** A preview-tier token that still carries account-wide access is broker-only too (decision 159). */
  brokerOnly?: boolean;
}
export interface AccountSpec {
  provider: string;
  title: string;
  create: string[];
  scope: string[];
  tokens: TokenSpec[];
}

export const GITHUB: AccountSpec = {
  provider: "github",
  title: "GitHub",
  create: ["A fine-grained personal access token: github.com > Settings > Developer settings > Personal access tokens > Fine-grained tokens > Generate new token."],
  scope: [
    "Resource owner: your own account. Repository access: only the repositories Jarvis works on.",
    "Repository permissions: Contents: read and write; Pull requests: read and write; Metadata: read-only (added automatically).",
    "Add Administration: read and write only if Jarvis should create repositories for you (the broker's git.create_remote).",
    "Expiration: 90 days. GitHub has no preview-only scope, so this token is broker-only.",
  ],
  tokens: [{ key: "GITHUB_TOKEN", label: "GitHub fine-grained token", tier: "production" }],
};

/**
 * Deploy hosts store two tokens (decision 159): the broker's deploy.preview adapter reads <PROVIDER>_PREVIEW_TOKEN and
 * deploy.promote (production, its inspection and rollback) reads <PROVIDER>_PRODUCTION_TOKEN, with no fallback from one
 * to the other. Neither provider can limit a token to previews, so both are broker-only; two tokens let a preview
 * token be revoked or rotated without touching production, and keep the tier split decision 12 asks for.
 */
export const VERCEL: AccountSpec = {
  provider: "vercel",
  title: "Vercel",
  create: ["Two access tokens: vercel.com > Account Settings > Tokens > Create Token, one named jarvis-preview and one named jarvis-production."],
  scope: [
    "Scope: your personal account (Hobby), not a team. Expiration: 90 days.",
    "Vercel tokens can't be limited to preview deployments, so both are broker-only: deploy.preview runs without asking with the preview token, and deploy.promote needs a grant bound to the exact release manifest (decision 12) and uses the production token.",
  ],
  tokens: [
    { key: "VERCEL_PREVIEW_TOKEN", label: "Vercel preview token (jarvis-preview)", tier: "preview", brokerOnly: true },
    { key: "VERCEL_PRODUCTION_TOKEN", label: "Vercel production token (jarvis-production)", tier: "production" },
  ],
};

export const NETLIFY: AccountSpec = {
  provider: "netlify",
  title: "Netlify",
  create: ["Two personal access tokens: app.netlify.com > User settings > Applications > Personal access tokens > New access token, one named jarvis-preview and one named jarvis-production."],
  scope: [
    "Set an expiration (90 days). Netlify personal access tokens carry your whole account's access and can't be limited to preview deploys, so both are broker-only: the preview token only ever deploys previews, and the production token needs a grant bound to the exact release manifest.",
  ],
  tokens: [
    { key: "NETLIFY_PREVIEW_TOKEN", label: "Netlify preview token (jarvis-preview)", tier: "preview", brokerOnly: true },
    { key: "NETLIFY_PRODUCTION_TOKEN", label: "Netlify production token (jarvis-production)", tier: "production" },
  ],
};

export const NEON: AccountSpec = {
  provider: "neon",
  title: "Neon (Postgres)",
  create: ["An API key: console.neon.tech > your organization's Settings > API keys > Create new API key."],
  scope: [
    "Prefer a key scoped to one project when Neon offers it for the project Jarvis builds; otherwise a personal key.",
    "Previews use Neon branches. The key can also create and delete branches and databases, so it is broker-only (data.delete needs approval).",
  ],
  tokens: [{ key: "NEON_API_KEY", label: "Neon API key", tier: "production" }],
};

export const CLOUDFLARE: AccountSpec = {
  provider: "cloudflare",
  title: "Cloudflare (Workers)",
  create: ["A custom API token: dash.cloudflare.com > My Profile > API Tokens > Create Token > Create Custom Token."],
  scope: [
    "Permissions: Account > Workers Scripts: Edit. Add D1 or R2 edit only when a project needs them.",
    "Account resources: only your account. Zone resources: none. Set a TTL (90 days).",
    "Workers have no preview-only token, so this one is broker-only.",
  ],
  tokens: [{ key: "CLOUDFLARE_API_TOKEN", label: "Cloudflare API token", tier: "production" }],
};

export const EXPO: AccountSpec = {
  provider: "expo",
  title: "Expo (EAS)",
  create: ["An access token: expo.dev > Account settings > Access tokens. Prefer a robot user in your organization (Organization settings > Members > Robot users) over a personal token."],
  scope: [
    "Give a robot the Developer role, not Admin or Owner.",
    "Internal-distribution builds are the preview path. The token can also start production builds and store submissions, so it is broker-only (store.submit needs approval).",
  ],
  tokens: [{ key: "EXPO_TOKEN", label: "Expo access token", tier: "production" }],
};

export const OAUTH: AccountSpec = {
  provider: "oauth",
  title: "OAuth app for sign-in (development)",
  create: ["A development OAuth app for Better Auth sign-in (decision 33): github.com > Settings > Developer settings > OAuth Apps > New OAuth App (or a Google Cloud OAuth client)."],
  scope: [
    "Homepage URL: http://localhost:3000. Callback URL: http://localhost:3000/api/auth/callback/github (local only).",
    "This development app is preview-tier. A separate production OAuth app is created at ship time (stage 5) and will be broker-only.",
  ],
  tokens: [
    { key: "OAUTH_DEV_CLIENT_ID", label: "OAuth client ID", tier: "preview" },
    { key: "OAUTH_DEV_CLIENT_SECRET", label: "OAuth client secret", tier: "preview" },
  ],
};

/** The fixed accounts; accounts.deploy asks Vercel or Netlify first. */
export const ACCOUNTS: Partial<Record<StepName, AccountSpec>> = {
  "accounts.github": GITHUB,
  "accounts.neon": NEON,
  "accounts.cloudflare": CLOUDFLARE,
  "accounts.expo": EXPO,
  "accounts.oauth": OAUTH,
};
export const DEPLOY: Record<string, AccountSpec> = { vercel: VERCEL, netlify: NETLIFY };
