# Recording intake decisions

Use one call per decision. State the decision itself with who gave it and the question ID, not a raw acknowledgement. A design direction pick is Taste, whoever gave it. User attribution requires the exact recorded answer in --recorded-answer and its verified --answer reference; never manufacture user answers.

| What came back | How it's recorded | `--by` | `--class` |
|---|---|---|---|
| An id listed in the session's submission | The user's explicit decision: firm, only the user changes it | `user` | `taste` for design, otherwise `mechanical` |
| An unlisted id in a submission, or "Use defaults" | An accepted default: firm until the user changes it | `default-accepted` | `taste` for design, otherwise `mechanical` |
| No answer by the deadline | An unconfirmed default: confirmed with the user once, vetoable in the morning | `default-unconfirmed` | `taste` |
| A free-text answer in the session that matches no option | The user's explicit decision, in their words; if it's ambiguous, record your reading of it as an assumption rather than asking again | `user` | `taste` for design, otherwise `mechanical` |

```
jarvis decide --by user --class mechanical|taste --why "<the question's why>" --alternatives "<the options not taken>" --depends-on "<what depends on it, for Taste>" --answer <answerSeq>:<questionId> --recorded-answer "<the exact recorded answer>" --source docs/intake/<file>.md "<the decision itself, with question ID>"
jarvis decide --by default-accepted --class mechanical|taste --why "<the default's reason; who answered questionId>" --alternatives "<the alternatives>" --depends-on "<what depends on it, for Taste>" --source docs/intake/<file>.md "Q<n>: <the decision the default selects>"
jarvis decide --by default-unconfirmed --class taste --why "<the default's reason>" --alternatives "<the alternatives>" --depends-on "<the stories or tasks it shapes>" --source docs/intake/<file>.md "Q<n>: <the decision the default selects>"
jarvis decide --by jarvis --class mechanical|taste --why "<the rationale>" --alternatives "<the alternatives>" --depends-on "<what depends on it, for Taste>" --source docs/research/<file>.md "<the engineering decision>"
jarvis decide --by user --class mechanical|taste --supersedes <id> --reason "<the user's words>" --why "<why the new request wins>" --depends-on "<what depends on it, for Taste>" --answer <answerSeq>:<questionId> --recorded-answer "<the exact recorded answer>" --source docs/intake/<file>.md "<the decision itself, with question ID>"
jarvis decide --by jarvis --class challenge --why "<why the rule may be wrong>" --alternatives "<what Jarvis would do instead>" --source docs/research/<file>.md "<the challenge>; the user's rule stays active"
```
