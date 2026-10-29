import test from 'node:test';
import assert from 'node:assert/strict';
import { connectedPhoneScreens } from '../public/scripts/cluster-screens.js';

const now = Date.parse('2026-10-29T21:00:00Z');
const fixture = () => ({ alive: true, last_seen_at: new Date(now - 5000).toISOString(), phone_controller: {
  schema: 1, server_state: 'available', checked_at: new Date(now - 10000).toISOString(),
  devices: ['173', '174', '176', '177', '191', '195', '253', '254'].map(id => ({ unit: 'phone' + id, state: id === '253' ? 'connected' : 'disconnected' })),
} });
test('only a fresh authorized screen connection enables its own phone viewer', () => {
  const result = connectedPhoneScreens(fixture(), now);
  assert.deepEqual(result.units, ['phone253']);
  assert.equal(result.expiresAt, now + 55000);
});
test('worker heartbeats alone never grant screen access', () => {
  assert.equal(connectedPhoneScreens({ alive: true, nodes: [{ id: 'phone253', online: true }] }, now), null);
});
test('stale, future, offline and unavailable controller data stay disabled', () => {
  for (const change of [x => x.alive = false, x => x.last_seen_at = new Date(now - 61000).toISOString(),
    x => x.phone_controller.checked_at = new Date(now - 91000).toISOString(),
    x => x.phone_controller.checked_at = new Date(now + 31000).toISOString(),
    x => x.phone_controller.server_state = 'unavailable']) {
    const value = fixture(); change(value); assert.equal(connectedPhoneScreens(value, now), null);
  }
});
test('duplicate, missing, foreign and invalid device entries cannot enable a viewer', () => {
  for (const change of [x => x.devices[0] = x.devices[1], x => x.devices.pop(),
    x => x.devices[0].unit = 'S26', x => x.devices[0].state = 'online']) {
    const value = fixture(); change(value.phone_controller); assert.equal(connectedPhoneScreens(value, now), null);
  }
});
