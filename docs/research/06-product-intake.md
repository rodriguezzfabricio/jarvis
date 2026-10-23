# Research notes: Product thinking and intake

Raw findings from a research agent, Oct 23, 2026. These fed `docs/01-decisions.md`. Claims marked secondary or unverified in the text should be checked before relying on them.

---

RESEARCH REPORT: Product intake, build-vs-buy spikes, and umbrella detection for "Jarvis"
(Sources were verified live on 2026-10-23 unless marked otherwise. Evidence caveat: none of the product frameworks below has been tested in controlled studies with agents. They are practitioner methods. The only data-backed piece is the question-count and timing work you already have.)

1. RECOMMENDED INTAKE METHOD (ordered)

0. Size gate. If everything that matters is already in the request, just do it and say what you did. Otherwise run the procedure below. (obra/superpowers "brainstorming" skill.)
1. Look before you ask. Read the host codebase and the data model of the connected tool. Never ask something the code already answers. (superpowers)
2. Frame the job and write the user guide first. Write one job story (situation, motivation, outcome; Intercom/Klement). Then write a short "day after launch" paragraph in second person: what the user does, what they see, and where they see it. Add an internal FAQ covering alternatives, risks and the top 3 reasons it could fail. This adapts Amazon's PR/FAQ: drop the market and economics parts, keep the customer-experience narrative and the internal-FAQ rigor. Why: this step forces the "how will he actually use it and see it" thinking the agent skipped.
3. Story-map the narrative. Lay out the backbone of user activities from trigger to outcome, with the variations listed under each activity (Patton). Run the umbrella test (section 4). Mark the walking skeleton.
4. Run the solution-space spike (section 3) before asking anything. What the research finds creates or kills questions. In the example, LinkedIn's terms rule out an "auto-DM" option, and API pricing creates a budget question. Spec Kit runs research only after the spec, during /plan, which is too late for this.
5. Shape (Shape Up). Set an appetite: a time, money and API-credit budget, not an estimate. List rabbit holes (from the spike plus a pre-mortem) and no-gos.
6. Sort every open decision into product or engineering. Rule: it is a product question if it changes what the user sees, does, pays or risks, or if it causes an irreversible effect outside the machine (messages to real people, spending money, posts, account bans). Everything else is engineering: decide it and log it as Decision / Rationale / Alternatives (Spec Kit's research.md format). Rank product questions scope > security/privacy/legal > UX > technical (Spec Kit's /specify order). Ask at most 5, 7 as a hard maximum. Each question gets a one-line "why it matters", a recommended default with its reason, and 2–3 alternatives; "reply 'defaults' to accept all" (Spec Kit's /clarify format). Anything over the cap becomes a logged assumption.
7. Write the spec:
   - user stories ranked P1/P2/P3, each testable on its own (Spec Kit template);
   - acceptance criteria in EARS form, "WHEN <event> THE SYSTEM SHALL <behavior>" (Kiro), so the agent can check its own work while the user is away;
   - goals and non-goals, P0/P1/P2 (Anthropic's write-spec skill);
   - an assumptions ledger.
8. Ask once. Then build the walking skeleton first, "on crutches" (manual stand-ins for unbuilt parts; Adzic). Verify it against the EARS criteria, then build the remaining slices in story-map order.
9. Hard rule: the agent working unattended while it builds is not the same as the product acting unattended once it runs. Irreversible external actions ship behind human approval by default.

2. FRAMEWORK COMPARISON (fit for a one-pass autonomous agent)

| Framework | What the agent takes from it | Weakness for agents | Fit |
|---|---|---|---|
| Story mapping (Patton) | Backbone, narrative order, walking skeleton, release slices. Exposes umbrellas. | Needs the user to confirm the flow (the map is what gets shown) | High (core) |
| Shape Up (appetite, rabbit holes, no-gos) | Fixed budget with variable scope; risks named up front; out-of-scope list. Its "grab-bag" warning is an umbrella signal. | Assumes human shapers and 6-week cycles; appetite has to be turned into time, money and credits | High |
| JTBD / job stories | Puts situation and outcome ahead of solution; cheap, one sentence | Built on real-user interviews; here the single user is the only "customer" | High (framing) |
| PR/FAQ (Working Backwards) | Experience-first narrative; internal FAQ demands alternatives, risks and "top 3 reasons it could fail" | Market size, unit economics and press framing don't apply | Med-High (as "user guide first") |
| PRD templates (Anthropic write-spec, ChatPRD, Lenny 1-pager) | Output format: problem, goals/non-goals, P0–P2, open questions tagged by owner | Formats, not discovery methods. ChatPRD's template is long and mixes in tech-stack sections | Medium (output only) |
| Opportunity solution trees (Torres) | Compare at least 3 solutions; test the riskiest assumptions | Built for continuous weekly interviews; too heavy for one pass | Low (borrow the 2 rules) |

Published agent skills, with what is good or weak in each:
- Spec Kit /specify: Good: at most 3 [NEEDS CLARIFICATION] markers; "make informed guesses" and record them under Assumptions; scope > security > UX priority; independently testable P1–P3 stories; spec quality checklist. /clarify: a coverage scan against a fixed category list, at most 5 questions, a recommended option with reasoning, a "why it matters" line. Weak: the spec forbids implementation detail, and /plan's research is framed as "best practices for {tech}" after the user has already named the stack, so there is no build-vs-buy step and no prior-art search.
- Kiro: Good: EARS criteria are machine-checkable, with requirements → design → tasks gates. Weak: the docs show no clarifying-question step and no research into existing solutions. The user reviews generated requirements instead, which moves the burden onto them.
- Anthropic product-management write-spec (knowledge-work-plugins): Good: non-goals with rationale, P0 test ("if we cut this, does it still solve the problem?"), open questions tagged with who must answer. Weak: asks questions conversationally rather than front-loaded, and asks the user for prior art instead of researching it.
- Matt Pocock skills (to-spec, to-tickets, wayfinder; grill-me already covered): Good: tracer-bullet vertical slices sized to one context window, with explicit blocking edges; wayfinder turns a foggy effort into typed decision tickets (research, prototype, grilling, task). Weak: grill-me interviews one question at a time with no end, the opposite of "leave the computer"; to-spec does no interviewing at all.
- superpowers brainstorming: Good: "look before you ask", name a cheaper path, lay out approaches. Weak: one question per message.
- Lenny's writing-prds (RefoundAI): a digest of principles (problem-first, one page, shaping) with no procedure. ChatPRD: asks questions only "if it needs to" and reviews assumptions after the draft.
- Worth borrowing: Anthropic's doc-coauthoring "reader testing" step, which checks the doc with a fresh Claude that has no context.

3. BUILD-VS-BUY SPIKE PROCEDURE

Trigger: the feature needs external data, touches a common problem (auth, email, search, enrichment, payments, scraping), or acts on third parties.
1. Write the needed capability as a job plus constraints: expected volume, budget, legal or ToS limits, hosting (for example, whether outbound port 25 is available), latency.
2. Search channels in parallel:
   - the existing repo and the host tool's plugins;
   - package registries;
   - GitHub topics and awesome-lists;
   - vendor APIs (fetch the pricing pages live and record the date);
   - MCP servers and skills;
   - practitioner write-ups.
   Always include "manual / do nothing" as an option. (ECC "search-first" skill.)
3. Shortlist 3–5 candidates (Torres: compare at least 3) and score them on a fixed rubric:
   - fit to the job;
   - cost at expected volume, including the free tier;
   - ToS and legal exposure;
   - maintenance, using OpenSSF's tests: commits and a release within 12 months, more than one maintainer, a clear OSI license, deps.dev Scorecard;
   - security;
   - lock-in;
   - setup friction.
4. Timeboxed hands-on test (XP spike: a throwaway program that answers one hard question). Run the finalists against a small golden set and measure hit rate, accuracy and cost per success. Russ Cox: write tests aimed at the functionality you actually need, and keep them for re-running on upgrades.
5. Decide: Adopt / Extend-wrap / Compose / Build (ECC decision matrix). Record it in research.md as Decision / Rationale / Alternatives, with the price-check date and a re-evaluation trigger.
6. Wrap the choice behind your own interface so the provider can be swapped.
7. Escalate to the user only if the choice crosses the product line (costs money, carries ToS risk, acts on their behalf). It then becomes one of the defaulted questions.
Gap in published skills: ECC's search-first only covers libraries. It has no step for paid APIs, ToS or legal review, or golden-set testing. Jarvis should add all three.

4. UMBRELLA DETECTION AND DECOMPOSITION

Signals (each maps to a source pattern):
- Several verbs chained together ("find… and reach out"). Each verb is a backbone activity.
- Fallback conditionals ("recruiter, or the hiring manager if none"). These are rule variations and alternate paths (SPIDR "Paths/Rules"; Humanizing Work "business rule variations").
- "For each" or "whenever". This implies a trigger, scheduling and idempotency.
- Words like "manage", "handle", "automate". These hide several operations (Humanizing Work).
- Data the system doesn't have. This means an acquisition sub-workflow plus a spike.
- An output the user must see or approve, with no screen or surface named. This is a missing UX flow.
- Effects on third parties (real people receive something). This means an approval and safety workflow.
- A time dimension (replies, follow-ups). This means a lifecycle or state machine.
- No single one-sentence problem can be named. This is Shape Up's "grab-bag".

Rule (my synthesis, not data-backed): treat a request as an umbrella if it has 3 or more backbone activities with external dependencies, or 2 or more activities with at least 2 viable variations.

Decomposition:
1. Map the backbone.
2. List the variations under each activity.
3. Find the core complexity and cut the variations down to one complete path through it (Humanizing Work's meta-pattern).
4. That path is the walking skeleton. Put crutches (manual steps) where questions or vendor decisions are still open.
5. Order the remaining slices by value. Each slice must be a vertical, demoable, INVEST-sized slice that fits one context window (Pocock to-tickets).
6. Only spend questions on forks that change what the user experiences. Defer everything else as P1/P2.

5. WORKED EXAMPLE: RECRUITER / HIRING-MANAGER OUTREACH

What Jarvis should have produced first:
- Job story: "When I submit an application, I want the right person at that company to hear from me personally within a day, so my application isn't lost in the ATS pile."
- Story map backbone:
  1. Application submitted (trigger from the tool)
  2. Resolve the company domain and team
  3. Find candidate people
  4. Pick the target (recruiter → technical recruiter → inferred hiring manager)
  5. Get a channel (find and verify the email; LinkedIn profile URL)
  6. Draft the message
  7. User reviews and approves
  8. Send
  9. Track (bounce, reply, one follow-up, stop)
  10. Digest
- Walking skeleton: for one application, show a review card with 1 contact, a verified email, the source of each fact, and a draft. On Approve it sends through the user's Gmail and records status. Crutch: the user marks "replied" by hand.
- Later slices: hiring-manager fallback → follow-ups and reply detection → LinkedIn manual assist → opt-in auto-send for high-confidence contacts → analytics.
- This clearly passes the umbrella test: 10 activities, several with external dependencies and variations.

Research it should have run (verified 2026-10-23):

Where the recruiter's identity can come from:
- The job post text itself.
- Public ATS APIs (Greenhouse Job Board, Lever Postings). Both are readable without auth and expose department and team, which lets Jarvis infer the hiring manager's title. Neither returns a recruiter or hiring-manager field.

Contact and enrichment APIs:
- Hunter: Domain Search filters by department=hr and returns position, a confidence score, the company's email `pattern`, and `sources` with last_seen_on dates. Email Finder costs 1 credit, charged only if an email is found; the Verifier costs 0.5 credit. Free plan: 50 credits/month. Starter: $49/month ($34/month billed annually) for 2,000 credits. Growth: $149/month for 10,000. Rate limit: 15 requests/second.
- Apollo: its docs say API access is on all plans and that only enrichment uses credits (1 credit for an email; "all other endpoints do not consume credits", so People Search appears to be free). Plans: Free 75 credits/month; Basic $49 (annual) / $65 (monthly) per seat with 2,500 credits; Professional $79 / $99 with 4,000. The plan figures are secondary: a Valley blog post that read Apollo's page on 2026-10-06, because Apollo's own pricing page would not render for me. Whether the free plan's API really allows People Search needs a spike.
- Snov.io: the trial has 50 credits and no API. Starter costs $39/month for 1,000 credits and includes the API.
- People Data Labs: the free plan gives 100 credits/month, but emails and phone numbers are obfuscated. Pro starts at $98/month for 350 credits.

Search engines (for finding people via public search, so-called "X-ray" queries):
- Google Custom Search JSON API is closed to new customers; existing customers must move off it by 2027-01-01.
- Bing Search APIs were retired in August 2025.
- Brave Search API: $5 per 1,000 requests with $5 of free credit a month. Storing results requires a plan with storage rights.
- Serper: 2,500 free queries, advertised from $0.30 per 1,000.

Open-source email tools:
- Reacher check-if-email-exists: Rust, about 10k stars, now MIT-licensed (it used to be AGPL; the repo and docs say MIT in 2026). Needs outbound port 25; the README says anything beyond small volumes needs SMTP proxies.
- AfterShip email-verifier: Go, MIT. SMTP checking is off by default because most ISPs block port 25.
- mailscout: Python, MIT. Generates name permutations and does SMTP and catch-all checks. Last release January 2024, which fails OpenSSF's 12-month test.
- email-sleuth: a tiny fork with 0 stars. Reject.
- theHarvester: its README limits use to authorized security assessments. Wrong tool; reject.

Email verification:
- ZeroBounce: 100 free validations a month; pay-as-you-go from $39 for 2,000 (about $0.02 each).
- Catch-all domains and greylisting defeat SMTP checks, so "accept_all" and "unknown" results must be flagged, never treated as valid.

Pattern guessing: take Hunter's `pattern`, or generate permutations (first.last, flast, …), then verify. Keep this as the fallback, not the primary path.

LinkedIn:
- User Agreement §8.2 bans scraping, bots, and automating messages or contact actions. I could not fetch it directly (robots-blocked), so this is quoted via secondary sources. LinkedIn's help pages warn that accounts using such tools can be restricted.
- Enforcement: Proxycurl was sued in January 2025 and shut down in July 2025 under a permanent injunction. ProAPIs was sued in October 2025 over alleged millions of fake accounts. Courts found hiQ breached the User Agreement.
- Conclusion: no LinkedIn automation. Manual assist only (profile link plus a note to paste).

Spike pick, logged as an engineering decision:
- Primary: Hunter Domain Search with department=hr. It answers "who recruits at company X, and what is their email" in one call, and the free tier covers a pilot.
- Fallbacks: Apollo People Search, then search-engine X-ray queries for the hiring manager, then pattern guess plus verification (ZeroBounce, or self-hosted Reacher only if port 25 is open).
- Golden set: 10 past applications where the true contact is known.
- Rough cost (my estimate): about $0 for a pilot of 15–25 jobs; about $34–49/month at 100–300 applications a month.

Product questions (7), each with a recommended default:
1. Who presses send? Default: Jarvis drafts and you approve each one in a daily review queue (batch-approve allowed); no auto-send in v1. Why: these messages go to real people, can't be recalled, and carry your name.
2. Which channels? Default: email from your own Gmail. For LinkedIn, Jarvis gives you the profile link and a note under 300 characters to paste yourself. Why: LinkedIn automation risks your account (§8.2).
3. Who gets contacted per application? Default: 1 person, recruiter first, then technical recruiter, then the inferred hiring manager. At most 1 person per company per week. No generic careers@ addresses. Why: several people at once looks like spam.
4. Timing and follow-up? Default: the next business day after applying, during the recipient's business hours. One follow-up after 5 business days, then stop. Stop immediately on any reply or bounce.
5. Message style? Default: plain text, 120 words or fewer. Your template plus one specific line drawn from the job post. A link to your portfolio or LinkedIn, no attachment. Only facts grounded in the post or your profile.
6. Budget? Default: $0 for the pilot (free tiers). Ask before any spending above $10/month; upgrade path is Hunter Starter at $34–49/month.
7. Where do you see it? Default: an "Outreach" view inside the job tool, or a local page if the tool can't host one. One row per application: contact, title, confidence, source link, draft, and status (drafted, approved, sent, bounced, replied, followed up). Plus a daily digest email to yourself.

Engineering decisions Jarvis makes alone (each logged with rationale):
- Trigger: hook into or poll the tool's application records. Make it idempotent with one key per (application, contact) so a re-run never sends twice.
- Wrap providers behind a ContactFinder / Verifier interface with a fallback chain and per-provider credit counters. Cache by company domain for 30–90 days.
- SQLite tables: contacts (with provenance: source URL and last-seen date), outreach state machine, events, and a global suppression list.
- Sending:
  - Gmail API with the gmail.send scope ("sensitive"), or SMTP with an app password. Drafts would need gmail.compose, which Google classifies as "restricted".
  - Don't leave the OAuth app in "Testing" status: Google expires refresh tokens there after 7 days, which would silently break an unattended run.
- Deliverability: plain text, no tracking pixels, no attachments. Pace sends at 20/day or fewer with random gaps.
- Handle bounce notifications: mark the address invalid and add it to suppression. On a reply, stop follow-ups.
- Treat "accept_all" and "unknown" addresses as low confidence, shown in the review queue and never auto-approved.
- The LLM drafts only from grounded facts, and each draft carries citations.
- Build modes: dry-run, send-to-self, and a pause switch.
- Keep secrets in env or the keychain. Ship tests on fixture jobs.

Risks a senior engineer would flag:
- Deliverability and account risk. Gmail requires every sender to have SPF or DKIM, valid DNS, TLS, and a spam rate below 0.3% (target under 0.1%). The bulk rules (DMARC, one-click unsubscribe) apply above 5,000 messages a day. Personal Gmail is capped at 500 messages a day; Workspace at 2,000. The real risk at this scale is bounces from guessed addresses plus spam reports damaging the user's personal account. Hence verification, low volume, and review.
  (Opinion: cold-email practitioners use separate domains and warm-up. For low-volume 1:1 job outreach, the personal account plus caution is reasonable.)
- CAN-SPAM. It covers B2B email and turns on whether the message's "primary purpose" is commercial. A job seeker's outreach is probably not commercial, but that is my reading, not FTC guidance. Penalties are up to $53,088 per email. It costs little to comply anyway: honest headers and subject, a real identity, and honoring "don't contact me" immediately (the law's limit is 10 business days).
- GDPR, for EU/UK users or recipients. The household exemption needs "no connection to a professional… activity", so it is doubtful for a job search. Treat GDPR as applying: legitimate interest as the legal basis, minimal data, deletion on request, a retention limit, and the Art. 14 notice "at the latest at the time of the first communication". In practice, one line saying where the address came from plus an opt-out. Not legal advice.
- Terms of service. Covers LinkedIn as above, plus vendor terms and Brave's storage-rights limit. theHarvester and similar OSINT tools are scoped to security work.
- Unreviewed messages to real people. Risks include misdirected email (a guessed address reaches the wrong person), stale data (the person has left the company), invented personalization, duplicate sends, and over-contacting one company. Mitigations: the approval gate, provenance shown on every card, idempotency, and per-company caps.

KEY SOURCES
Spec Kit specify/clarify/plan templates: github.com/github/spec-kit/tree/main/templates. Kiro: kiro.dev/docs/specs/concepts and /feature-specs/requirements-first. Anthropic write-spec: github.com/anthropics/knowledge-work-plugins (product-management/skills/write-spec). Anthropic doc-coauthoring: github.com/anthropics/skills. Pocock: github.com/mattpocock/skills. superpowers: github.com/obra/superpowers. ECC search-first: github.com/affaan-m/everything-claude-code. Lenny skills: github.com/RefoundAI/lenny-skills. ChatPRD: chatprd.ai/docs/writing-your-first-prd. Shape Up: basecamp.com/shapeup (chapters 1.2, 1.5). Patton: jpattonassociates.com/the-new-backlog. PR/FAQ: workingbackwards.com. Job stories: intercom.com/blog/using-job-stories-design-features-ui-ux. OST: producttalk.org/opportunity-solution-trees. Humanizing Work splitting guide; Mountain Goat SPIDR; gojko.net (skeleton on crutches); extremeprogramming.org/rules/spike.html; research.swtch.com/deps; best.openssf.org Concise Guide. Hunter pricing and API docs; knowledge.apollo.io and docs.apollo.io; joinvalley.co Apollo pricing (secondary); snov.io/pricing; peopledatalabs.com/pricing/person; zerobounce.net pricing; github.com/reacherhq/check-if-email-exists; github.com/AfterShip/email-verifier; pypi.org/project/mailscout; github.com/laramies/theHarvester; developers.google.com/custom-search/v1/overview; brave.com/search/api; serper.dev; developers.greenhouse.io/job-board.html; github.com/lever/postings-api; Bloomberg Law 2025-12-18 and Social Media Today (Proxycurl, ProAPIs); contentin.io (quoting LinkedIn §8.2, secondary); support.google.com/mail/answer/81126 and /22839; Workspace sending limits; Gmail API scopes; Google OAuth2 docs (Testing-mode token expiry); ftc.gov CAN-SPAM guide; gdpr-info.eu Art. 14 and Recital 18.