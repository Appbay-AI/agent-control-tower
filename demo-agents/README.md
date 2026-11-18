# Demo agents (task 7.2)

Two small AI agents, written with LangGraph, that run on the demo laptop and talk to the Control Tower exactly as a
real agent would (the API in `docs/agent-api.md`). They never move real money: the "SWIFT gateway" is simulated.

| Agent | Code | What it shows |
|---|---|---|
| Payment Release Assistant | AGT-0001 | Asks before every payment. The £2m to Hartwell Steel is above its £250,000 limit, so it **waits for people** and pays only when they approve. In routine mode it **stops within seconds of the kill switch**. |
| Sanctions Pre-screener | AGT-0003 | May only observe and recommend. It tries to release a held payment, the Control Tower **refuses it by policy**, and it hands the case to a person. |

## One-time set-up on the demo laptop (about 10 minutes)

1. **Install Python** 3.10 or newer from https://www.python.org/downloads/ (on Windows, tick *Add python.exe to PATH*
   on the first screen).
2. **Get this folder**: download the repository from GitHub (*Code → Download ZIP*) and unzip it, or use a copy you
   already have. Open the `demo-agents` folder.
3. **Open a terminal in that folder**: on Windows, right-click inside the folder → *Open in Terminal*; on a Mac, open
   *Terminal*, type `cd ` (with a space) and drag the folder onto the window, then press Enter.
4. **Install LangGraph** (copy and paste each line, then press Enter):

   Windows:
   ```
   python -m venv .venv
   .venv\Scripts\activate
   pip install -r requirements.txt
   ```
   Mac:
   ```
   python3 -m venv .venv
   source .venv/bin/activate
   pip install -r requirements.txt
   ```
5. **Settings**: copy `.env.example` to a new file called `.env` in the same folder and open it in Notepad or
   TextEdit. `ACT_URL` is already the client demo site.
6. **Keys** (repeat after every demo data reset, because a reset deletes all keys): sign in to the Control Tower as
   the admin, open **Agents → Payment Release Assistant → API keys → New key**, copy the key into `.env` after
   `PAYMENT_AGENT_KEY=`. Do the same for the **Sanctions Pre-screener** (`SCREENING_AGENT_KEY=`). Save the file.
   The key is shown only once; if you lose it, revoke it and make a new one.

Each time you open a new terminal for the demo, run the second line of step 4 again (`.venv\Scripts\activate` or
`source .venv/bin/activate`) before the commands below.

## The cues

| Cue | Type this | What happens |
|---|---|---|
| The £2m payment | `python payment_agent.py hartwell` | The agent reads invoice HS-48817, asks the Control Tower, and waits. The request appears in Ravi Menon's Approvals list and on his phone. When Ravi and a second approver approve, the agent checks once more and releases the payment. If they turn it down, it pays nothing. |
| Refused by policy | `python screening_agent.py` | The screener tries to release a payment it may only recommend; the Control Tower refuses at once and the agent hands the case over. |
| The kill switch | `python payment_agent.py run` | Routine payments within its limit, one every 6 seconds, each allowed at once. Press **Suspend now** on the agent's page: the agent stops at its next check, within a few seconds, and makes no more payments. Switch it back on afterwards through the reactivation approval. |
| Any payment | `python payment_agent.py pay --amount 480000 --supplier "Calder Logistics"` | One payment of your choice. |

Add `--test` to any cue for a rehearsal: the requests are marked as tests, so nobody is emailed or alerted.
Press **Ctrl+C** to stop an agent yourself.

Before the demo:

- The demo data already has a £2m Hartwell request waiting for Ravi (made by the reset). Either use that one, or
  decide it before the demo so the agent's live request is the only one in Ravi's list.
- After the kill-switch cue the Payment Release Assistant is suspended: switch it back on before running the £2m cue.
- To rehearse without touching the client demo site, set `ACT_URL=https://main.agent-control-tower-56p.pages.dev` and
  use keys made there.

## If something goes wrong

| You see | Do this |
|---|---|
| `Set ACT_URL and PAYMENT_AGENT_KEY in demo-agents/.env first` | Step 5 or 6 is missing, or `.env` is not in the `demo-agents` folder. |
| `Invalid or revoked agent key` | The key was revoked or deleted by a reset: make a new key (step 6). |
| `AGT-0001 is suspended` | The kill switch is on: switch the agent back on (reactivation) or use the other agent. |
| `Could not reach the Control Tower` | Check the internet connection and `ACT_URL`. The agent never acts when it cannot ask. |
| `No module named langgraph` | Run the activate line from step 4, then try again. |

## For developers

- `act.py` is the API client (standard library only, fails closed); `show.py` prints the steps; each agent is a
  LangGraph `StateGraph` whose every path to an action passes the Control Tower's status check and decision.
- Tests against a stand-in Control Tower: `python -m unittest discover demo-agents` (run in *Checks*).
- Against the real API: the *Demo agents* workflow runs all three cues against a site using the work-in-progress
  database, with test requests, and approves the £2m request as Ravi Menon and Daniel Okafor.
