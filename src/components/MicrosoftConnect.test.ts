// Task 3.1 (resumed): the address the browser is sent to for Microsoft sign-in.
import { describe, expect, it } from 'vitest'
import { microsoftSignInUrl } from './MicrosoftConnect'

describe('Connect Microsoft (task 3.1)', () => {
  it('sends the code-flow request with the PKCE challenge, state and our return address', () => {
    const url = new URL(microsoftSignInUrl({ authorize_url: 'https://login.microsoftonline.com/t-1/oauth2/v2.0/authorize', client_id: 'c-1',
      redirect_uri: 'https://main.example.dev/api/v1/microsoft/callback', scope: 'https://api.powerplatform.com/.default offline_access openid profile',
      state: 'mss_abc', code_challenge: 'xyz', code_challenge_method: 'S256' }))
    expect(url.origin + url.pathname).toBe('https://login.microsoftonline.com/t-1/oauth2/v2.0/authorize')
    expect(Object.fromEntries(url.searchParams)).toEqual({ client_id: 'c-1', response_type: 'code', redirect_uri: 'https://main.example.dev/api/v1/microsoft/callback',
      response_mode: 'query', scope: 'https://api.powerplatform.com/.default offline_access openid profile', state: 'mss_abc', code_challenge: 'xyz',
      code_challenge_method: 'S256', prompt: 'select_account' })
  })
})
