import { json, out, info, warn, UserError } from "../logger.js";
import { proposalToIncidents, publishImprovements } from "../improvements.js";

/** Reuse the saved proposal. This command never calls an analysis/synthesis model. */
export async function cmdImprovements(ctx) {
  const proposal = ctx.config.state.readProposal();
  if (!proposal) throw new UserError("no saved Backpass proposal", "run `backpass propose` first, then retry");
  const incidents = proposalToIncidents(proposal);
  const url = ctx.flags["pab-url"] || process.env.BACKPASS_PAB_URL;
  if (!url) {
    if (ctx.flags.json) json(incidents);
    else out(`${incidents.length} evidence-backed improvement(s) ready; use --pab-url to submit to PAB`);
    return 0;
  }
  if (!incidents.length) {
    if (ctx.flags.json) json({ sent: 0, receipts: [] });
    else warn("no evidence-backed project correction targets were found in the saved proposal");
    return 0;
  }
  try {
    const result = await publishImprovements(incidents, url);
    if (ctx.flags.json) json(result);
    else out(`submitted ${result.sent} improvement(s) to PAB for matching and review`);
    return 0;
  } catch (error) {
    throw new UserError(
      `PAB improvement intake failed: ${error.message}`,
      "the Backpass proposal remains saved; retry `backpass improvements --pab-url <loopback-origin>`",
    );
  }
}

export async function publishIfConfigured(proposal, ctx) {
  const url = ctx.flags["pab-url"] || process.env.BACKPASS_PAB_URL;
  if (!url) return;
  try {
    const incidents = proposalToIncidents(proposal);
    if (!incidents.length) return;
    const result = await publishImprovements(incidents, url);
    info(`submitted ${result.sent} evidence-backed improvement(s) to PAB`);
  } catch (error) {
    warn(`PAB improvement intake failed (${error.message}); proposal saved; retry with backpass improvements`);
  }
}
