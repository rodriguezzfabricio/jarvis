# Upstream and modifications

Source repository is [Google Elephant–Goldfish Model](https://github.com/google/elephant-goldfish-model/tree/113a3afc44e8f4f54722d7150d5701f65cc8ef7f), pinned at `113a3afc44e8f4f54722d7150d5701f65cc8ef7f` on November 3, 2026. License is Apache-2.0, reproduced in [LICENSE](../LICENSE). The source tree has no NOTICE file.

The Jarvis comprehension role adapts [agents/comprehension.md](https://github.com/google/elephant-goldfish-model/blob/113a3afc44e8f4f54722d7150d5701f65cc8ef7f/agents/comprehension.md). The skill adapts the document-only comprehension step and fresh-context dispatch principles from [skills/egm-review/SKILL.md](https://github.com/google/elephant-goldfish-model/blob/113a3afc44e8f4f54722d7150d5701f65cc8ef7f/skills/egm-review/SKILL.md).

Modified for Jarvis on November 3, 2026. The role is review-only, uses an explicit full model ID and Read-only tool list, and reports completion separately from findings. The workflow uses Jarvis's fixed spec grammar, companion-file boundaries, existing spec critic, three-pass budget, one confirmation and four resolution actions. It preserves both upstream paraphrase headings and writes reports under the author-only intake directory. Upstream brainstorming, bootstrap, drift report and interactive five-stage loops are not bundled. The existing runner already implements adapted zoom-out, design critic and implementation readiness lenses in review/plan-lenses.ts.

Updates require reviewing the upstream diff and rerunning packaging and workflow checks. These files are bundled with Jarvis and require no runtime download or separately installed EGM plugin. This adaptation is maintained by Jarvis and is not an officially supported Google product.
