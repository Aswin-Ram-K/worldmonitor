// The Country Brief MCP App card must not show the generating model id
// (plan KTD7: `model` stays in the API response, leaves every rendered surface).
//
// Drives the genuine emitted shell the same way tests/mcp-world-brief-app-stale.test.mts
// does: the HTML `resources/read` serves plus the host postMessage handshake.

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { Window } from 'happy-dom';

import { COUNTRY_BRIEF_APP_HTML } from '../api/mcp/ui/country-brief-app';

async function render(payload: Record<string, unknown>) {
  const win: any = new Window({ url: 'https://worldmonitor.app/' });
  win.document.write(COUNTRY_BRIEF_APP_HTML);
  await win.happyDOM.waitUntilComplete();
  const script = win.document.querySelector('script');
  assert.ok(script && script.textContent.length > 0, 'app shell must ship an inline bridge script');
  win.eval(script.textContent);
  await win.happyDOM.waitUntilComplete();
  const hostWindow = win.eval('window.parent');
  win.dispatchEvent(new win.MessageEvent('message', {
    data: {
      jsonrpc: '2.0',
      method: 'ui/notifications/tool-result',
      params: { result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } },
    },
    source: hostWindow,
  }));
  await win.happyDOM.waitUntilComplete();
  return win;
}

describe('api/mcp/ui/country-brief-app.ts', () => {
  it('renders the brief and generation date without the model id', async () => {
    const win = await render({
      countryCode: 'FI',
      countryName: 'Finland',
      brief: "SITUATION NOW\nFinland's fiscal space scores 28 of 100 in the Country Resilience Index. [E2]",
      model: 'seeded-model-id-xyz',
      generatedAt: Date.UTC(2026, 8, 23),
      sources: [],
    });
    try {
      const body = win.document.body.textContent;
      assert.match(body, /fiscal space scores 28 of 100/);
      assert.match(win.document.getElementById('foot').textContent, /^Generated 2026-09-23/);
      assert.doesNotMatch(body, /seeded-model-id-xyz/);
    } finally {
      await win.happyDOM.close();
    }
  });
});
