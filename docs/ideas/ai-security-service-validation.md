# Validation report: an autonomous "AI security engineer" sold as a service

Date: 2026-10-25. Author: Claude (Fable 5.1) with Fabricio. Mode: decision + build-research.
Status: reviewed by Codex (PASS WITH CHANGES, see §11); changes applied. Not part of the Jarvis decision register.

Labels used on claims: [fact] observed in a primary or news source · [vendor] a company's own claim · [est] third-party estimate · [inf] my inference · [spec] speculation.

---

## 0. The decision in five lines

1. **Do not build "an AI that finds vulnerabilities."** Finding is being done at scale by frontier labs and $250M+ companies and is getting cheaper. [fact; "solved" would overstate it]
2. **The unsolved, paid problem is turning a finding into a merged, proven fix.** 6% of Glasswing findings patched; curl's bounty died under AI noise; HackerOne paused its Internet Bug Bounty because fixing, not finding, is the bottleneck. [fact]
3. **Small engineering teams are already served** at $39–$499/month by five or more funded products, plus GitHub and OpenAI natively. Don't start there. [fact]
4. **Test two first buyers, not one.** A: dev agencies/MSPs maintaining bespoke legacy web apps (fresh pain from PHP2Shell, PHP 8.2 security end Dec 31 2026, no funded code-fix seller). B (added after review): a small B2B SaaS team with an existing pentest finding blocking an enterprise deal, a runnable app and a technical owner. B has a deadline, a dollar consequence and acceptance criteria; A has more pain but vaguer budget and no CI. Both are interview hypotheses until someone pays. [inf]
5. **Sell a "Fix Pack," done-for-you first, product second, and keep the pilot narrow: one framework, a runnable staging environment, one finding class.** One finding or one runtime upgrade in, one merged PR out, with a reproduction test, green regression suite and a one-page evidence sheet the agency can forward to its client, insurer or auditor. Price per fix and per-app retainer. Productize once ten agencies have paid.

Confidence: medium on 1–3 (well sourced), low on 4–5. The decision-flipping claim is "someone will pay enough, per job, to cover my delivery cost"; nothing in this report supports it yet. Three requests for a quote are interest. Paid jobs with measured hours are evidence.

---

## 1. What the user asked and what I decided for them

Asked: validate the idea, pick the customer, pick the day-one job, research the delivery model, and treat revenue, fundraising, acquisition and portfolio as all in play.

Decided (and why, in one line each):
- **Customer: agencies/dev shops/MSPs with legacy custom web apps.** Only segment where pain is fresh, budget exists (they already bill clients $99–$349 per site per month for maintenance), and no funded competitor sells code fixes. [fact + inf]
- **Day-one job: fix, prove, hand over.** Not continuous find-and-fix (MindFort, depthfirst, Aikido own that), not watch-and-respond (an AI SOC is a 20-person company). [inf]
- **Delivery: done-for-you for ~90 days, then a self-serve GitHub/upload flow.** Security PRs from unknown bots get merged 13–37% of the time; a human name on the evidence sheet is what gets a first PR merged. [fact + inf]
- **Goal sequencing: revenue → proof → fundable/acquirable product.** Aikido, Check Point and Cohere all bought tiny remediation/security teams in 2026; what they bought was a working engine with named users, which a services phase produces. [fact]

---

## 2. What is happening right now (the "why now")

| Event | What it means for this idea | Source quality |
|---|---|---|
| PHP2Shell (CVE-2026-109618/9), disclosed Oct 21 2026, RCE in PHP 5.4–8.5, found with OpenAI GPT-5.6 Sol + Wiz | Fix lives in the PHP runtime, below WordPress/Laravel. Agencies could not fix it by updating the CMS. Old branches (≤8.1) got only source backports. Hosts lagged (0.08% of monitored sites patched hours after release; Censys: ~1.57M of 1.58M version-identifiable hosts unpatched on day one). | [fact] CNN, NPR, Wiz, Censys via SecurityWeek |
| Exploitation disputed | watchTowr saw in-the-wild attempts; CISA had not confirmed exploitation and had not KEV-listed as of Oct 23. Fear is high, confirmed damage is low. Fear-driven buying fades in weeks. | [fact] The Record, SecurityWeek |
| Project Glasswing (Anthropic, Claude Mythos): 10,000+ high/critical findings in a month, 90.6% true-positive rate; 97 of 1,596 disclosed findings patched as of May 22 | Discovery is solved at scale. Remediation is a ~6% pipeline. CSA's recommendation to security teams: "prioritize AI-enabled patch validation tooling." | [fact] Anthropic, CSA (CSA note self-labels as AI-assisted draft) |
| curl: 35 CVEs from one AI audit; bug bounty shut down under AI-generated noise. HackerOne IBB paused submissions March 2026 | Maintainers are drowning. Same pattern will hit every company that turns on an AI scanner. | [fact] TechTarget, Aisle |
| EU Cyber Resilience Act reporting duties live since Sep 11 2026; full obligations Dec 11 2027; fines up to €15M / 2.5% | Applies to manufacturers of products with digital elements, depending on product and operator role. It will create demand for vulnerability handling at some vendors; whether agencies inherit it depends on the contract. Treat as a tailwind, not a driver. | [fact] Jones Day, PwC |
| Cyber insurance renewals ask for documented patch SLAs and proof of closure | "Prove it was fixed" is now a document someone must produce. | [est] broker and vendor blogs; no insurer-published schedule found |
| PHP 8.2 security support ends Dec 31 2026; Laravel 12 security fixes end Feb 2027 | Second forcing date for the same buyer within 10 weeks. | [fact] php.net dates via eCorpIT |

Base rates: PHP runs 70.8% of sites with a known server language (W3Techs, July 2026). Within PHP 7 sites, ~26% are on 7.0–7.3 (all end-of-life). [fact, approximate]

---

## 3. Competitive map (who sells what, to whom, for how much)

| Tier | Who | Money | Sells | Published price | Gap for us |
|---|---|---|---|---|---|
| Autonomous pentest (find) | XBOW ($272M, $1B val), Horizon3 ($437M, $2B, 7,000 orgs), RunSybil ($40M), Armadin ($255M Series B), Tenzai, TENEX, Fleuret, Hex (YC W26), Veria (YC F25) | Enormous | Continuous exploitation proof | None published | None. Do not enter. |
| Find + fix, enterprise | depthfirst ($120M; Lovable, Supabase, AngelList), Pixee (76% merge rate [vendor], 1–5 line fixes), Aisle (curl; being acquired by Cohere), Mobb | Large | Ready-to-merge PRs for AppSec teams | None published | Top-down sales. Fixes are narrow. Nobody does multi-file legacy fixes with proof. |
| Find + fix, small teams | MindFort (YC X25): $499/mo, find+prove+patch+retest, "the only human decision is merging." Corgea $39–49/dev. ZeroPath ~$200–1,000/mo. Aikido $300–$1,050/mo flat + $4k pentests. GitHub Code Security $30/committer incl. Copilot Autofix. OpenAI Codex Security free in ChatGPT Business for now. | Seed to $1B | Scanner + autofix in CI | Yes, $39–$499 | Saturated. Entering here means out-marketing nine products with a worse brand. |
| Agent runtime security | Noma ($132M), Reco ($140M), WitnessAI, NeuralTrust, Zenity, Lakera, Nvidia OpenShell | Large | Guardrails for AI agents | None | Not a solo product. |
| MSP channel remediation | Cork Cyber (Pax8 vendor of the year; 50k remediation runs on 250k devices [vendor]; ~$0.35–$1 per unit [est]) | Mid | Endpoint/OS patching for MSPs | Partial | Endpoints, not application code. Adjacent, possible channel partner. |
| WordPress agencies | Patchstack: $69/mo Developer (3 seats, +5 sites $12.50), "web host" and "enterprise/MSP" tiers; RapidMitigate virtual patches "without changing code" | Small-mid | Plugin CVE blocking | Yes | Owns WordPress plugin CVEs. Does **not** touch bespoke app code or runtime upgrades. |
| Extended PHP support | TuxCare / CloudLinux ELS for PHP, sold through cPanel and hosts: security patches while keeping the existing PHP version | Mid | Backported runtime patches for EOL PHP | Via host channel | **Direct substitute for the "EOL means forced migration" story.** Does not fix bespoke app bugs. Weakens the Runtime Upgrade Pack, not the Fix Pack. Added after Codex review (cPanel docs). |
| Legacy PHP upgrades | Rector (open-source tool + "upgrade team," no public price; claims 3 months → 3 days [vendor]); offshore agencies (Dubai example: 30–80 days of work for a 5.6→8 upgrade) | Small | Human-led migrations | No | Human-paced, project-priced, no proof artifact. This is the hole. |

**Reading of the map [inf]:** every funded player sells to a company that has its own engineers and a GitHub org. The buyer with 30 client apps on five different PHP versions, no CI, and a client asking "are we safe?" has Patchstack for plugins and nothing for code.

---

## 4. Buyer: who pays, why, and how much they already spend

**Primary: dev agencies, dev shops, MSPs with a web practice (5–50 people, 20–300 client apps).**
- Already charge $99–$349 per site per month for maintenance plans; enterprise sites $2k–$10k/mo. [est] Seahawk, Websults, Codeable
- 48% of SMBs lean on MSPs; 84% of SMB owners self-manage security; 44% say they would pay more for AI-powered detection/response. [fact] WatchGuard n=842, VikingCloud
- Their pain on Oct 21: "emergency patch becomes forced migration, with costs for old plugins and bespoke code." [fact] BISI report
- What they lack: a way to say to the client, with a document, "patched, proven, here is the test."

**Secondary (later): small eng teams drowning in scanner output.** Only after the engine is proven, and only on fix depth, because the price shelf there is $39–$499.

**Not a buyer:** open-source maintainers (real pain, no budget; useful for reputation only).

**Willingness-to-pay anchors:**
- A manual pentest: $3k–$10k single app, $15k–$35k multi-scope; retest $2k–$5k. [est]
- Aikido pentest: $4,000 in credits. MindFort: $499/mo. [fact, vendor pages]
- Cyber insurance for a 50-person tech firm: $2k–$6k/yr; patch SLA evidence affects terms. [est]

---

## 5. Packaging and pricing (proposal, all [spec] until tested)

**Product name on the invoice: a "Fix Pack."** One input, one proven output.

| SKU | Input | Output | Price idea | Anchor |
|---|---|---|---|---|
| Fix Pack | One CVE, scanner finding, or pentest item on one app | PR with a reproduction test (fails before, passes after), existing tests still passing, one-page evidence sheet | $400–$1,500 [spec: compares different services; set after measuring hours] | Pentest retest $2k–$5k; MindFort $499/mo |
| Runtime Upgrade Pack | One app on EOL PHP/Node/Rails | App on supported runtime, same tests green, diff report, rollback plan | $2k–$8k per app | Human upgrade: 30–80 days |
| Patched & Proven retainer (do not offer until delivery cost is known) | All of an agency's apps | Monthly sweep + evidence binder | $150–$400 per app per month wholesale. Note: a 2x resale means $300–$800 retail, above the $99–$349 maintenance range, so the margin story is unproven | WP care plans $99–$349 |
| Evidence sheet (standalone) | A fix someone else made | Reproduction + verification + signed sheet | $150–$300 | Insurer/auditor demand |

Rules: price per outcome, not per seat (agencies hate seats). Publish prices (most AI security vendors hide them; MindFort, Aikido and Corgea publish, so it is a small differentiator, not a unique one). Do not run 20 free jobs: free tests free demand and burns scarce capacity. Offer 3–5 paid design-partner jobs at a discount with a fixed scope and written acceptance test.

---

## 6. User experience (how it feels to the agency)

1. **Intake (2 minutes):** connect a GitHub/GitLab repo, or upload a tarball + a URL. Many agency apps have no CI; the product must not require one.
2. **Reproduce:** the agent stands the app up in a sandbox and demonstrates the finding (or, for an upgrade, runs the existing tests and records the baseline). The agency sees a short "we reproduced it" note with the exact request. No reproduction → no charge, the job stops here. This is the trust move.
3. **Fix:** the agent patches, writes the failing-then-passing test, runs the whole suite, and opens a PR on a branch named `fixpack/...`. It never pushes to main.
4. **Evidence sheet:** one page. What was wrong, the proof it was wrong, what changed, the proof it is fixed, who signed. Agency forwards it to the client, insurer or auditor.
5. **Merge:** the only human decision. In the done-for-you phase, Fabricio reviews before the PR is opened; later, a confidence gate decides which PRs get a human look.

Design tells that matter (from the Pixee data on why 85% of security PRs are ignored): fixes must match the codebase's style and dependency versions, each PR is small and explained, and quality must be consistent because one bad fix kills trust for every later one.

---

## 7. How it works (architecture, and where the risk is)

- Orchestrator: one agent harness with a sandboxed build loop and an evidence-based "done" (the same shape as Jarvis, not necessarily Jarvis itself). Model-agnostic interface; Claude or Codex behind it.
- Sandbox is the product's safety claim: agent cannot read credentials, cannot reach the network except the package cache, every command logged. Sell this openly. Buyers in 2026 vet trust before demos. [fact] Foundra
- Known failure modes to design against: sandbox escapes via files that host tools later execute (Cursor/Codex/Gemini CLI, patched); prompt injection in repo comments and dependency docs; 36% of successful attacks on coding agents reached RCE on the dev machine [vendor] Straiker. The agent must treat the customer's repo as hostile input.
- Liability: a services contract with a hold-harmless clause and E&O insurance before touching a client's production code. [inf] Not researched in depth.
- What the labs will eat: generic "scan and autofix in CI." Whether they will also serve legacy apps is speculation; watch quarterly. [spec]
- Delivery reality (Codex): the likely failure is days spent reconstructing environments, databases and undocumented behavior before any fix. A merged PR is not a deployed fix, and passing tests is not proof of app-wide security. Missing tests make "suite green" a weak promise. A student's signature does not give independent assurance, so do not call the sheet an assurance document.

---

## 8. Go-to-market (solo founder, zero budget)

1. **Lead magnet this week:** "Is your client's PHP actually patched?" Version strings mislead (Ubuntu 24.04 still reports 8.3.6 after backport); a checker that reads the package changelog for the CVE is more reliable than anything agencies are using. Free, runs in the browser or as a one-liner, collects an email. [fact on the version-string problem]
2. **Ten conversations in 14 days:** agency owners and MSP techs. Script: "What did you do the week of Oct 21? What did it cost? What would you have paid to have it done with proof?"
3. **Channel, not ads:** hosting providers (Patchstack's "web host" tier shows the model), Laravel and WordPress agency communities, MSP distributors (Pax8 made Cork its vendor of the year; MSPs buy through distributors).
4. **Trust page before the demo:** sandbox description, what the agent can and cannot touch, incident script, your name.
5. **Publish prices.** Many vendors hide them; small buyers dislike that.

The Harvey comparison (analogy only; it is priced for $400–$800/hr associates): Harvey sells per-seat bundles at $500–$2,000 per lawyer per month with 20-seat minimums, which "filters out most of the world's lawyers." The agency market is the opposite shape. Copy Harvey's vertical workflow packaging, not its pricing.

---

## 9. Acquisition and fundraising path

- **Serial acquirers of tiny remediation/security teams in 2026:** Aikido bought Root (agentic patching, est. $70–100M), Trag, Allseek, Haicker; Check Point bought Deepchecks' team for $10–20M; Cohere is buying Aisle; OpenAI is buying Promptfoo; Databricks bought Antimatter; A10 bought TrojAI. [fact, SecurityWeek, Dealroom]
- **What they bought [inf, motives not stated by the buyers]:** apparently an engine and a team more than revenue; Root's draw is in-place patches without upgrades.
- **Natural acquirers for this specific wedge:** Aikido (SMB brand, 100k teams), Patchstack (agency channel, no code fixes), Cork Cyber (MSP channel, endpoints only), hosting companies, Rector's parent.
- **Fundable story at 12 months [spec]:** "N paying customers, human hours per fix falling from A to B, X% of PRs merged without edits, evidence sheets accepted by Y insurers/auditors." The evidence-acceptance metric is the only possible moat and is unproven.

---

## 10. Adversarial pass (questions that could flip the answer, and where they stand)

| Question | Disposition |
|---|---|
| MindFort already does find+prove+patch+retest for $499/mo. Isn't "remediation for small teams" taken? | **Yes, for small eng teams with CI.** That is why the buyer moved to agencies with legacy apps and no CI. Checked MindFort's legacy IT page: it tests legacy apps black-box ("if it answers HTTP, it can be tested"), no source needed, and re-runs the exploit to confirm a fix. It does **not** write the fix, upgrade runtimes, or manage many client apps. So MindFort can be the finder for our buyer; we are the fixer. Partner candidate, not a blocker. [fact, vendor page] |
| Patchstack already serves WordPress agencies. | **Partly.** Patchstack blocks plugin CVEs without changing code. It does not fix bespoke code or upgrade runtimes. Risk: Patchstack adds a "fix" product; mitigation: be their partner or their acquisition. |
| Is the AI-hacking wave real demand or a news cycle? | **Both.** PHP2Shell exploitation is contested and fear will fade. The durable drivers are PHP 8.2 EOL (Dec 31), CRA (Sep 2026 / Dec 2027), insurer patch SLAs. Sell on the calendar, not the headline. |
| Will anyone merge a PR from an unknown student's bot? | **Not without a human name.** Bot PRs merge at ~37%, Dependabot security PRs ~13% in JS OSS. Hence done-for-you first, evidence sheet signed, confidence gate later. |
| The labs will ship this natively. | **They are shipping scan+autofix in CI.** GitHub ($30/committer), Codex Security (free for now). Whether they will serve legacy apps is unknown. If they do, the wedge is dead; watch quarterly. |
| Agencies are cheap and slow to buy. | **Open.** The one number that matters: will 3 of 10 say "send me a quote." No evidence either way yet. |
| Is this a services business pretending to be a product? | **For the first 90 days, yes, on purpose.** The product is the engine + the evidence sheet; the service phase is how you learn what "proof" buyers accept. If after 10 paid Fix Packs the engine still needs a human on every job, it is a services business and should be priced like one. |
| Can a solo CS senior run this safely and legally? | **Open.** Needs an E&O policy, a contract template, and the sandbox story written down. Not researched in depth here. |
| Is "legacy PHP" too narrow? | **Narrow is the point for the pilot.** One framework, runnable staging, one finding class. A transferable multi-runtime engine is unsupported by any evidence yet. |
| Extended PHP support (TuxCare) removes the forced-migration pressure. | **Accepted.** It weakens the Runtime Upgrade Pack and the Dec 31 deadline story. The Fix Pack (bespoke app bugs) is not affected. Added from Codex review. |
| The agency's own developer or a freelancer is the real substitute. | **Accepted, unanswered.** The interview question must be "who fixed it last time and what did it cost." |

Assumption-base challenge: the whole plan assumes "proof" has buyer value. Pixee's data (merge rates rise with evidence) and insurer/auditor demand support it, but no agency has yet said they'd pay for the sheet. That is the single most important thing to learn in the ten conversations.

---

## 11. Independent review

Reviewer: OpenAI Codex, codex-cli 0.164.0, model gpt-6-astra, read-only sandbox, stdin closed, a different model family from the author. It was given this report plus six criteria. It reported opening primary sources itself (cPanel docs, EU Commission CRA summary), so my earlier note that it would not search was wrong. Limits: one pass, no customer data, no access to my transcripts.

**Verdict: PASS WITH CHANGES.** Keep the service experiment. The market choice and the autonomous-product thesis are not validated.

| Codex finding | Disposition |
|---|---|
| Decision-flipping claim is "agencies will pay enough per job to cover delivery cost"; asserted, not supported. Quotes are interest; paid jobs with measured hours are evidence. | **Accepted.** Moved to §0 as the claim to test; kill criteria in §12 now use paid jobs. |
| TuxCare/CloudLinux extended PHP support is a direct substitute for the forced-migration story; the agency's own developer is another. | **Accepted.** Added to §3 and §10. Runtime Upgrade Pack demoted. |
| Agencies/MSPs/shops differ in budget; "no CI" removes the infrastructure for cheap proof. Strongest alternative: a SaaS team with a pentest finding blocking an enterprise deal. | **Accepted.** §0 now tests both buyers. |
| Prices are weakly anchored; retainer at 2x resale implies $300–$800 retail, above $99–$349; "N fixes included" makes profit unknowable; free jobs test free demand. | **Accepted.** §5 revised: retainer withheld until costs are known; 3–5 paid design partners instead of 20 free. |
| 90 days: narrow supervised pilot yes; autonomous multi-runtime no. Likely failure: environment reconstruction. Student signature is not assurance. | **Accepted.** Pilot narrowed; §7 adds delivery reality. |
| Overstated: "discovery is solved," "nobody publishes prices," CRA scope, "merged PR = fixed," "labs won't," acquirer motives, multi-runtime engine. | **Accepted and corrected** in §0, §2, §5, §7, §8, §9, §10. |

Not changed: the claim that remediation, not discovery, is the bottleneck. Codex noted a single patch-rate snapshot lacks finding age; I kept it as evidence of direction, not a steady-state rate.

---

## 12. Residual unknowns and what would change the answer

- No customer has been spoken to. Proceed only on paid jobs: 2 paid pilots at a fixed scope with written acceptance tests, and measured human hours per job. Quote requests alone are not enough. If neither buyer A nor B pays, stop or reframe.
- MindFort's and Aikido's real behavior on legacy apps without CI (not tested).
- Whether insurers or SOC 2 auditors accept an AI-produced evidence sheet with a human signature (sources say methodology and independence matter more than who ran it; no auditor confirmed).
- Legal/insurance cost of touching client production code as a solo operator.
- PHP2Shell patch rate as of today (last data Oct 21–23).

## 13. Cheapest next observation

Write one paid-pilot offer (fixed scope, one framework, one finding class, written acceptance test, price) and send it with the questions below. Also post one message in two agency communities (a Laravel agency Slack or Discord, and an MSP forum) asking: "What did you do the week of Oct 21, what did it cost you, and would you have paid for someone to patch and prove it?" Zero cost, 48 hours, tells you whether to book the ten calls.

---

## Sources
PHP2Shell: https://www.wiz.io/blog/php2shell-php-rce · https://www.cnn.com/2026/10/21/tech/php2shell-vulnerability-ai-intl · https://www.npr.org/2026/10/23/g-s1-149503/hacking-php-flaws · https://www.securityweek.com/php2shell-exploitation-started-days-before-patches/ · https://therecord.media/php-php2shell-exploitation-attempts-pocs · https://www.guidepointsecurity.com/blog/how-to-patch-php2shell/ · https://www.martincid.com/technology-sv/php2shell-php-patch-wordpress-sites-host/ · https://bisi.org.uk/reports/php2shell-critical-php-vulnerabilities-and-the-fragility-of-the-webs-foundations · https://projectdiscovery.io/research/php2shell
Patch gap / Glasswing / curl: https://www.anthropic.com/glasswing · https://www.helpnetsecurity.com/2026/05/26/anthropic-project-glasswing-update/ · https://labs.cloudsecurityalliance.org/research/csa-research-note-glasswing-ai-vuln-patching-deficit-2026060/ · https://www.techtarget.com/cybersecurity/news/366652233/Historic-Curl-flaw-shows-AI-risk-to-legacy-supply-chain · https://aisle.com/blog/curl-adopts-aisle-after-its-ai-agents-discovered-5-cves
Agent incidents: https://www.cbsnews.com/news/openai-ai-agent-bot-rogue-hack-government-website/ · https://80000hours.org/hugging-face/
Competitors: https://dealroom.co/charts/ai-cybersecurity-startups · https://www.businesswire.com/news/home/20260331071577/en · https://depthfirst.com/case/how-persona-increased-code-security-coverage-by-2x-with-depthfirst · https://docs.pixee.ai/faq/general · https://www.pixee.ai/blog/merge-rate-problem-security-prs-ignored · https://mindfort.ai/pricing · https://patchstack.com/pricing/ · https://codeant.ai/blogs/aikido-security-pricing · https://toolradar.com/tools/corgea · https://www.capterra.com/p/10031949/ZeroPath/ · https://redresscompliance.com/microsoft-github-advanced-security-licensing.html · https://openai.com/index/introducing-aardvark/ · https://aimagazine.com/news/cohere-targets-agentic-ai-security-via-aisle-deal · https://yespress.io/mindfort-ai-yc-x25.md · https://ycombinator.com/companies/industry/security · https://techcrunch.com/2026/09/29/reco-raises-55m-as-ai-agent-security-startups-crowd-the-market/ · https://www.channelinsider.com/security/cork-cyber-msp-vulnerability-remediation/ · https://channelbuzz.ca/2026/04/cork-cyber-is-evolving-from-cyber-warranty-provider-to-msp-security-platform-46168/ · https://www.getrector.com · https://kolonell.com/en/blog/legacy-php-app-modernisation-budget-dubai-2026 · https://ecorpit.com/php-development-company/
Merge-rate evidence: https://arxiv.org/abs/2604.19965 · https://arxiv.org/abs/2601.00477 · https://arxiv.org/html/2602.00164v1
Buyers / pricing anchors: https://seahawkmedia.com/wordpress/wordpress-maintenance-packages/ · https://websults.com/web-development/maintenance/pricing/ · https://blog.getagency.com/articles/soc-2-penetration-test-cost-2026 · https://www.startupdefense.io/blog/penetration-testing-cost · https://securitybrief.news/story/small-businesses-fear-ai-cyberattacks-watchguard-finds · https://www.vikingcloud.com/press-news/cyberattacks-overtake-inflation-and-recession-concerns-as-the-1-threat-to-smbs-in-2026-new-vikingcloud-research-finds · https://www.meriplex.com/managed-security-services-cost/ · https://w3techs.com/technologies/comparison/pl-php
Regulation / insurance / audit: https://www.jonesday.com/en/insights/2026/07/eu-cyber-resilience-act-24hour-reporting-duties-start-september-11-2026 · https://www.pwc.ch/en/insights/regulation/eu-cyber-resilience-act.html · https://www.mis-solutions.com/?p=14862 · https://vulert.com/blog/cyber-insurance-open-source-vulnerabilities/ · https://www.stingrai.io/blog/will-an-auditor-accept-an-ai-pentest-2026 · https://nhimg.org/articles/ai-pentesting-can-satisfy-compliance-but-only-within-limits/
M&A: https://www.securityweek.com/cybersecurity-ma-roundup-37-deals-announced-in-june-2026/ · https://www.securityweek.com/cybersecurity-ma-roundup-26-deals-announced-in-may-2026/ · https://siliconangle.com/2026/06/30/aikido-acquires-root-patch-open-source-without-forced-upgrades/ · https://www.cnbc.com/2026/01/08/crowdstrike-ai-cybersecurity-sgnl-acquisition.html · https://www.infosecurity-magazine.com/news-features/cyber-ma-roundup-march-26/
Agent security / trust: https://www.straiker.ai/report/threat-research-vol-i/coding-agents · https://www.bleepingcomputer.com/news/security/cursor-codex-gemini-cli-antigravity-hit-by-sandbox-escapes/amp/ · https://www.foundra.ai/key-reads/security-trust-reviews-close-enterprise-deals-2026 · https://learn.microsoft.com/en-us/training/modules/github-copilot-code-agent/2-security-risks-limitations-copilot-code-agent
Harvey: https://www.vaquill.ai/blog/harvey-ai-review-honest-assessment · https://www.bindlegal.com/resources/comparisons/harvey-pricing-2026/
