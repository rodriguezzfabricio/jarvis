import { z } from "zod";
import type { ReleaseProjectConfig } from "./types.ts";

const destination = z.object({
  // One canonical spelling prevents case/optional-.git aliases from defeating tier separation.
  repo: z.string().regex(/^git@github\.com:[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9_-]*\.git$/),
  branch: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/),
  url: z.string().regex(/^https:\/\/[a-z0-9][a-z0-9-]*\.onrender\.com$/),
}).strict();
export const renderSetupSchema = z.object({ preview: destination, production: destination }).strict().superRefine((s, ctx) => {
  if (s.preview.repo === s.production.repo || s.preview.url === s.production.url) ctx.addIssue({ code: "custom", message: "Render tiers need separate repos and sites" });
});
export function validateRenderSetup(config: ReleaseProjectConfig): void {
  const setup = renderSetupSchema.parse(config.render);
  if (config.productionUrl !== setup.production.url) throw new Error("Render production origin differs from setup");
}
