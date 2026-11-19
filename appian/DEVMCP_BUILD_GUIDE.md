# Building the simulator with Appian DevMCP and Claude Code

Who: one developer on the Appian team, on their own computer. Time: about a day, mostly reviewing what Claude builds.
What gets built: everything in [SIMULATOR_SPEC.md](SIMULATOR_SPEC.md).

DevMCP is Appian's community-supported plug-in that lets Claude Code read and write Appian design objects
([Appian docs](https://docs.appian.com/suite/help/26.7/devmcp.html)). It runs on the developer's computer and signs in
through their browser, so this cannot be done from Appbay's cloud workspace.

## 1. One-time setup

**Appian administrator**

1. Administration Console → Plug-ins → search for and deploy **Appian Dev MCP**.

**Developer** (Mac or Linux terminal; Windows: use WSL)

1. Install uv: `curl -LsSf https://astral.sh/uv/install.sh | sh`
2. Download the server bundle from `https://<your-site>/suite/plugins/servlet/stateless/downloads`, then:

   ```bash
   mkdir -p ~/appian-dev-mcp-server
   tar -xzf ~/Downloads/appian-dev-mcp-server-bundle.tar.gz -C ~/appian-dev-mcp-server
   cd ~/appian-dev-mcp-server && uv sync && uv run playwright install chromium
   ```

3. Get this repository: `git clone https://github.com/Appbay-AI/agent-control-tower.git && cd agent-control-tower`
4. Copy `appian/mcp.json.example` to `.mcp.json` in the repository root. Put in your Appian site address and the full
   path of `~/appian-dev-mcp-server`. Do not commit this file (it is ignored).
5. Start Claude Code in the repository folder (`claude`). The first DevMCP call opens a browser: sign in to Appian
   within five minutes. Sign in as a developer account in a **development** environment, not production.

## 2. Build, one prompt at a time

Paste each prompt into Claude Code in order. Let it finish, check the result in Appian Designer, then move on.
Every prompt asks Claude to show its plan first; reply "go ahead" when it looks right.

**Prompt 1: application and data**

```text
Read appian/SIMULATOR_SPEC.md completely. Using the Appian DevMCP tools, create an Appian application named
"Northbridge Agent Platform (simulated)" with object prefix NAP. Create the three record types NAP_AGENT,
NAP_AGENT_ACTIVITY and NAP_STATUS_HISTORY with the exact fields in the spec, stored in new database tables with data
sync. First list every object you will create and wait for my OK. Use only DevMCP tools; never touch other
applications.
```

**Prompt 2: seed data and reset**

```text
Following appian/SIMULATOR_SPEC.md, create the "Reset demo data" record action on NAP_AGENT, visible only to
administrators. It deletes all rows in NAP_AGENT_ACTIVITY and NAP_STATUS_HISTORY and rewrites NAP_AGENT to exactly the
eight seed agents in the spec (NAP-007 quarantined, the rest active, NAP-004 with no owner, NAP-003 shared with Ana
Costa, Sales Associate). Show me the plan first. Then tell me how to run it once.
```

**Prompt 3: the logic behind the APIs**

```text
Following the "Web APIs" section of appian/SIMULATOR_SPEC.md, create expression rules:
NAP_agentToApi (one NAP_AGENT row to the agent object, camelCase, owner null when blank, empty lists as []),
NAP_statusToApi (the status object), and NAP_validateStatusChange (returns an error text for a bad status or
missing field, empty when valid). Times must be ISO 8601 UTC ending in Z. Add test cases to each rule using the seed
agents, and run them. Show me the plan first.
```

**Prompt 4: the three web APIs**

```text
Create the three web APIs in appian/SIMULATOR_SPEC.md: GET nap-agents, GET nap-agent-status, POST
nap-agent-status-set, with exactly the responses, status codes and rules listed (setting the same status again
returns 200 and writes no history row; a real change writes NAP_STATUS_HISTORY with the reason and requestedBy).
If the DevMCP tools cannot create web APIs, say so plainly and instead give me step-by-step Appian Designer
instructions with the complete expression to paste for each one.
```

**Prompt 5: screens**

```text
Build the four screens in the "Screens" section of appian/SIMULATOR_SPEC.md and a site named "Northbridge Agent
Platform (simulated)" with that text in its header. Switch back on and Quarantine must record the signed-in user in
status_changed_by and in NAP_STATUS_HISTORY, and must not call the web API. The Activity screen refreshes every 10
seconds and shows blocked rows in red. Show me the plan first.
```

**Prompt 6: demo agents**

```text
Build the two demo agents in the "Demo agents" section of appian/SIMULATOR_SPEC.md as process models started by a
timer every minute. NAP-001 checks its own status in NAP_AGENT. NAP-002 calls Agent Control Tower's status API
through an Appian integration (connected system with a Bearer token from a constant; the base URL
https://agent-control-tower-56p.pages.dev) and treats any error or timeout as not allowed. Add a constant
NAP_CHECK_CONTROL_TOWER, default false, which skips that call until Appbay supplies the agent key. Show me the plan
first.
```

**Prompt 7: security checklist**

```text
List, as numbered steps I can follow in the Admin Console, how to create the service account act-integration, a
group that can only run the three NAP web APIs, and an API key for it. Do not create the API key yourself.
```

**Prompt 8: NAP-009 Payment Release Assistant (added 19 Nov 2026)**

```text
Read the section "NAP-009 Payment Release Assistant" in appian/SIMULATOR_SPEC.md, and the NAP-009 lines in Seed data,
Web APIs (API 4) and Acceptance checks. Add NAP-009 to the seed data and to Reset demo data, the activity outcome
"waiting", the Release a payment action and form on the Agent detail screen, the process model with its steps, the
connected system and the three constants (leave NAP_009_AGENT_KEY empty; I will paste the key), and web API 4. Show me
the plan first, then build it, then list what I must do by hand.
```

After it is built: in Control Tower, sign in as admin, open the Payment Release Assistant, **API keys → New key**, and
paste the key into `NAP_009_AGENT_KEY`. Add API 4 to the `act-integration` group. Run the three NAP-009 acceptance
checks.

## 3. Hand over

1. Do the Prompt 7 steps. Paste the API key straight into GitHub → agent-control-tower → Settings → Secrets and
   variables → Actions as `APPIAN_API_KEY`. Never send it by chat or email.
2. Tell Appbay the site address (`https://<your-site>`); it is not secret.
3. Run the acceptance checks at the end of the spec, for example
   `curl -H "Appian-API-Key: $APPIAN_API_KEY" https://<your-site>/suite/webapi/nap-agents`.
