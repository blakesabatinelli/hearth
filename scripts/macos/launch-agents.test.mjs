import assert from 'node:assert/strict';
import test from 'node:test';
import { renderLaunchAgent } from './launch-agents.mjs';

test('renders loopback Hearth LaunchAgents with keep-alive and private runtime paths', () => {
  const plist = renderLaunchAgent('web', {
    repoPath: '/tmp/Hearth & Home',
    runtimePath: '/tmp/Hearth <private>',
    wrapperPath: '/tmp/start Hearth.zsh',
  });

  assert.match(plist, /app\.hearth\.web/);
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
  assert.match(plist, /<key>ThrottleInterval<\/key><integer>10<\/integer>/);
  assert.match(plist, /Hearth &amp; Home/);
  assert.match(plist, /Hearth &lt;private&gt;/);
  assert.match(plist, /start Hearth\.zsh/);
  assert.doesNotMatch(plist, /session-secret|gateway-token|home-assistant-token|actuation-allowlist/);
});

test('refuses unknown service labels instead of emitting an untracked launch job', () => {
  assert.throws(() => renderLaunchAgent('homeassistant'), /unsupported Hearth service/);
});
