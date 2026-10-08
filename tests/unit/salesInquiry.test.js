// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { buildSalesInquiry, isValidMinutes, PRIVATE_CUSTOMER_ORGANIZATION } from '../../src/utils/salesInquiry';

describe('sales inquiry ("get more minutes")', () => {
  it('lets private customers leave the organisation empty', () => {
    expect(buildSalesInquiry({ email: 'a@b.ch', organizationName: '  ', minutesNeeded: 120, message: '' })).toEqual({
      email: 'a@b.ch', organizationName: PRIVATE_CUSTOMER_ORGANIZATION, minutesNeeded: 120, message: null
    });
  });

  it('keeps a given organisation and message, trimmed', () => {
    expect(buildSalesInquiry({ email: 'a@b.ch', organizationName: ' Muster AG ', minutesNeeded: '90.4', message: ' Hallo ' }))
      .toEqual({ email: 'a@b.ch', organizationName: 'Muster AG', minutesNeeded: 90, message: 'Hallo' });
  });

  it('validates the minutes', () => {
    expect(isValidMinutes(120)).toBe(true);
    expect(isValidMinutes('15')).toBe(true);
    for (const bad of ['', null, undefined, 0, -5, 'abc', NaN]) expect(isValidMinutes(bad)).toBe(false);
  });

  it('the send button is never disabled for missing input', () => {
    const source = fs.readFileSync('src/components/ContactSalesDialog.vue', 'utf8');
    expect(source).not.toMatch(/:disable="!/);
    expect(source).toMatch(/formRef\.value\.validate/);
  });
});
