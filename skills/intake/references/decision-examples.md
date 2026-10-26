# Recording intake decisions

Use one call per decision. User attribution requires the exact recorded answer and its verified reference; never manufacture user answers.

```
jarvis decide --by user --class mechanical --why "<the question's why>" --alternatives "<the options not taken>" --answer <answerSeq>:<questionId> --source docs/intake/<file>.md "<the exact recorded answer>"
jarvis decide --by default-accepted --class mechanical --why "<the default's reason>" --alternatives "<the alternatives>" --source docs/intake/<file>.md "Q<n>: <the default>"
jarvis decide --by default-unconfirmed --class taste --why "<the default's reason>" --alternatives "<the alternatives>" --depends-on "<the stories or tasks it shapes>" --source docs/intake/<file>.md "Q<n>: <the default>"
jarvis decide --by jarvis --class mechanical|taste --why "<the rationale>" --alternatives "<the alternatives>" --depends-on "<what depends on it, for Taste>" --source docs/research/<file>.md "<the engineering decision>"
jarvis decide --by user --class mechanical --supersedes <id> --reason "<the user's words>" --why "<why the new request wins>" --answer <answerSeq>:<questionId> --source docs/intake/<file>.md "<the exact recorded answer>"
jarvis decide --by jarvis --class challenge --why "<why the rule may be wrong>" --alternatives "<what Jarvis would do instead>" --source docs/research/<file>.md "<the challenge>; the user's rule stays active"
```
