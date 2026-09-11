# Oh My Pi port

[Back to the README](../README.md)

**Status: proposal. This repository currently installs into DeepSeek Harness.**

Oh My Pi (OMP) has the building blocks for the same workflow: skills for the
working rules, named agents for execution and review, and settings that control
which agents can spawn. Its existing support makes a port plausible; it does not
make this DSH package automatically compatible.

## Proposed package

- An OMP version of the skill, using OMP's `task` tool instead of DSH role tools.
- Agent definitions for the worker, explorer, researcher, tester, and reviewer.
- A setup check for Astra and DeepSeek model access in the installed OMP catalog.
- A documented lead default of Astra **xhigh**, DeepSeek workers at **high**, and
  a separate Astra reviewer at **high**.
- Tool restrictions and spawn settings to keep workers from delegating further.

OMP discovers project agents under `.omp/agents/*.md` and project skills under
`.omp/skills/<name>/SKILL.md`. With skill commands enabled, the intended entry
point could be `/skill:astra-orchestrator <task>`. That command is a proposed user
experience; this repository does not install or validate it yet.

## What needs verification

Model identifiers differ between hosts. Confirm available routes and supported
reasoning settings instead of copying DSH's `deepseek-official` provider name.
Then check model selection, reviewer restrictions, depth limits, and one complete
coding task with independent review. OMP settings and overrides must be checked
before claiming they enforce the same boundaries as the DSH preset.

Sources checked September 11, 2026:

- [OMP skills](https://github.com/can1357/oh-my-pi/blob/main/docs/skills.md)
- [OMP agent definitions and spawn policy](https://github.com/can1357/oh-my-pi/blob/main/docs/task-agent-discovery.md)
- [OMP configuration locations](https://github.com/can1357/oh-my-pi/blob/main/docs/config-usage.md)
