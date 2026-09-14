import { expect, it } from 'vitest';
import { gatewayApprovalPresentation } from './gateway-approval-presentation.js';
import type { GatewayApprovalRequest } from './gateway-providers/gateway-provider-registry.js';

const request = (summary?: GatewayApprovalRequest['summary']) =>
  ({ title: 'Legacy', question: 'Legacy question', summary }) as GatewayApprovalRequest;
const summary = {
  agent: 'Nano',
  action: 'Read external data',
  resource: 'GET api.example.test/repos?token=secret',
  reason: 'Policy requires approval',
};

it('shows action, resource, reason and one-request approval scope without query values', () => {
  const card = gatewayApprovalPresentation(request(summary));
  expect(card.title).toBe('Approve external request');
  expect(card.question).toContain('*Action:* Read external data');
  expect(card.question).toContain('*Resource:* GET api.example.test/repos');
  expect(card.question).toContain('*Why approval:* Policy requires approval');
  expect(card.question).toContain('this request once');
  expect(card.question).not.toContain('secret');
});

it('escapes supplied formatting and mentions, and bounds the card', () => {
  const card = gatewayApprovalPresentation(
    request({
      ...summary,
      agent: '<@everyone>\n*Admin*',
      details: Array.from({ length: 6 }, () => ({ label: 'Detail', value: 'a'.repeat(600) })),
    }),
  );
  expect(card.question).not.toContain('<@everyone>');
  expect(card.question).not.toContain('*Admin*');
  expect(card.question.length).toBeLessThanOrEqual(2600);
});

it('rejects malformed structured details instead of trusting them', () => {
  expect(() => gatewayApprovalPresentation(request({ ...summary, details: 'bad' as never }))).toThrow();
  expect(() => gatewayApprovalPresentation(request({ ...summary, action: '' }))).toThrow();
});

it('keeps legacy adapters compatible', () => {
  expect(gatewayApprovalPresentation(request())).toEqual({ title: 'Legacy', question: 'Legacy question' });
});

it('shows a concrete action, full issue number and submitted comment without generic padding', () => {
  const card = gatewayApprovalPresentation(
    request({
      agent: 'Nano',
      action: 'Post a comment',
      resource: 'example/repo · issue or PR #548',
      reason: 'This action changes external data.',
      details: [{ label: 'Comment', value: 'great job' }],
    }),
  );
  expect(card.title).toBe('Post a comment');
  expect(card.question).toContain('*Where:* example/repo · issue or PR #548');
  expect(card.question).toContain('*Comment:* great job');
  expect(card.question).not.toContain('business action');
});

it('preserves all typed policy display fields and explicit list overflow', () => {
  const card = gatewayApprovalPresentation({
    ...request(),
    displayFields: [
      ...Array.from({ length: 23 }, (_, i) => ({
        label: `Field ${i}`,
        type: 'long_text' as const,
        value: 'x'.repeat(1000),
      })),
      { label: 'Items', type: 'list', value: Array.from({ length: 50 }, (_, i) => `item-${i}`), overflow: 7 },
    ],
  });
  expect(card.question).toContain('Field 22');
  expect(card.question).toContain('item-49');
  expect(card.question).toContain('7 additional items');
  expect(card.question.length).toBeGreaterThan(23000);
});
