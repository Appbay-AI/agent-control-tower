#!/usr/bin/env node
// Registers an agent through the Control Tower API, then checks its status with the agent's own key.
// Usage: ACT_URL=https://... ACT_INTEGRATION_KEY=act_int_... node scripts/register-agent.mjs [agent.json]
import { readFileSync } from 'node:fs'

const base = process.env.ACT_URL?.replace(/\/$/, '')
const key = process.env.ACT_INTEGRATION_KEY
if (!base || !key) {
  console.error('Set ACT_URL and ACT_INTEGRATION_KEY')
  process.exit(2)
}

const agent = process.argv[2]
  ? JSON.parse(readFileSync(process.argv[2], 'utf8'))
  : {
      name: `API test agent ${new Date().toISOString().slice(0, 16)}`,
      department: 'Payments',
      business_owner_email: 'james.whitfield@northbridge.demo',
      purpose_statement: 'Registered by the API smoke test to prove the register endpoint works.',
      framework: 'langchain',
      autonomy_level: 3,
      value_threshold: 1000,
      risk_tier: 'low',
      systems_accessed: ['Test harness'],
      data_classifications: ['internal'],
    }

const res = await fetch(`${base}/api/v1/agents/register`, {
  method: 'POST',
  headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
  body: JSON.stringify(agent),
})
const body = await res.json()
if (res.status !== 201) {
  console.error(`Register failed: HTTP ${res.status}`, body)
  process.exit(1)
}
console.log(`Registered ${body.agent_code} (${body.status}); submitted for approval: ${body.submitted_for_approval}`)

const st = await fetch(`${base}/api/v1/agents/${body.agent_code}/status`, { headers: { authorization: `Bearer ${body.api_key}` } })
const status = await st.json()
if (st.status !== 200) {
  console.error(`Status check failed: HTTP ${st.status}`, status)
  process.exit(1)
}
console.log(`Status: ${status.status}, may act: ${status.may_act}`)
if (status.may_act) {
  console.error('A newly registered agent must not be allowed to act')
  process.exit(1)
}
// For callers that want to clean up afterwards.
console.log(`AGENT_ID=${body.agent_id}`)
