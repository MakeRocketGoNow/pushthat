import { Timestamp } from 'firebase-admin/firestore';

import { getBillingPeriodKey } from './billing';

describe('getBillingPeriodKey', () => {
  let originalDate: DateConstructor;
  const NOW = new Date('2024-01-31T12:00:00Z');

  beforeAll(() => {
    originalDate = global.Date;
    // Mock Date to return fixed time
    global.Date = class extends originalDate {
      constructor(date?: string | number | Date) {
        super(date ?? NOW);
      }
    } as DateConstructor;
  });

  afterAll(() => {
    global.Date = originalDate;
  });

  const testCases = [
    {
      name: 'Monthly subscription started last Feb 1st',
      subscription: {
        startedAt: Timestamp.fromDate(new Date('2023-02-01T12:00:00Z')),
        interval: 'monthly' as const,
      },
      createdAt: Timestamp.fromDate(new Date('1977-10-29T12:00:00Z')),
      expected: '2024-01',
    },
    {
      name: 'Monthly subscription started Feb 2nd',
      subscription: {
        startedAt: Timestamp.fromDate(new Date('2023-02-02T12:00:00Z')),
        interval: 'monthly' as const,
      },
      createdAt: Timestamp.fromDate(new Date('1977-10-29T12:00:00Z')),
      expected: '2024-01',
    },
    {
      name: 'Monthly subscription started Feb 28th',
      subscription: {
        startedAt: Timestamp.fromDate(new Date('2023-02-28T12:00:00Z')),
        interval: 'monthly' as const,
      },
      createdAt: Timestamp.fromDate(new Date('1977-10-29T12:00:00Z')),
      expected: '2024-01',
    },
    {
      name: 'Monthly subscription started Feb 29th',
      subscription: {
        startedAt: Timestamp.fromDate(new Date('2020-02-29T12:00:00Z')),
        interval: 'monthly' as const,
      },
      createdAt: Timestamp.fromDate(new Date('1977-10-29T12:00:00Z')),
      expected: '2024-01',
    },
    {
      name: 'Monthly subscription started Jan 16th',
      subscription: {
        startedAt: Timestamp.fromDate(new Date('2024-01-16T12:00:00Z')),
        interval: 'monthly' as const,
      },
      createdAt: Timestamp.fromDate(new Date('1977-10-29T12:00:00Z')),
      expected: '2024-01',
    },
    {
      name: 'Monthly subscription started Jan 28th',
      subscription: {
        startedAt: Timestamp.fromDate(new Date('2024-01-28T12:00:00Z')),
        interval: 'monthly' as const,
      },
      createdAt: Timestamp.fromDate(new Date('1977-10-29T12:00:00Z')),
      expected: '2024-01',
    },
    {
      name: 'Monthly subscription started Jan 29th',
      subscription: {
        startedAt: Timestamp.fromDate(new Date('2023-01-29T12:00:00Z')),
        interval: 'monthly' as const,
      },
      createdAt: Timestamp.fromDate(new Date('1977-10-29T12:00:00Z')),
      expected: '2024-01',
    },
    {
      name: 'Monthly subscription started Jan 30th',
      subscription: {
        startedAt: Timestamp.fromDate(new Date('2023-01-30T12:00:00Z')),
        interval: 'monthly' as const,
      },
      createdAt: Timestamp.fromDate(new Date('1977-10-29T12:00:00Z')),
      expected: '2024-01',
    },
    {
      name: 'Monthly subscription started Jan 31st',
      subscription: {
        startedAt: Timestamp.fromDate(new Date('2023-01-31T12:00:00Z')),
        interval: 'monthly' as const,
      },
      createdAt: Timestamp.fromDate(new Date('1977-10-29T12:00:00Z')),
      expected: '2024-01',
    },
    {
      name: 'Monthly subscription started Feb 1st',
      subscription: {
        startedAt: Timestamp.fromDate(new Date('2023-02-01T12:00:00Z')),
        interval: 'monthly' as const,
      },
      createdAt: Timestamp.fromDate(new Date('1977-10-29T12:00:00Z')),
      expected: '2024-01',
    },
    {
      name: 'Monthly subscription started last day of February',
      subscription: {
        startedAt: Timestamp.fromDate(new Date('2023-02-28T12:00:00Z')),
        interval: 'monthly' as const,
      },
      createdAt: Timestamp.fromDate(new Date('1977-10-29T12:00:00Z')),
      expected: '2024-01',
    },
    {
      name: 'Monthly subscription started 2 years ago',
      subscription: {
        startedAt: Timestamp.fromDate(new Date('2022-02-15T12:00:00Z')),
        interval: 'monthly' as const,
      },
      createdAt: Timestamp.fromDate(new Date('1977-10-29T12:00:00Z')),
      expected: '2024-01',
    },
    {
      name: 'Monthly subscription started around 2 years ago',
      subscription: {
        startedAt: Timestamp.fromDate(new Date('2022-02-16T12:00:00Z')),
        interval: 'monthly' as const,
      },
      createdAt: Timestamp.fromDate(new Date('1977-10-29T12:00:00Z')),
      expected: '2024-01',
    },
    {
      name: 'Yearly subscription started 14 months ago',
      subscription: {
        startedAt: Timestamp.fromDate(new Date('2023-01-15T12:00:00Z')),
        interval: 'yearly' as const,
      },
      createdAt: Timestamp.fromDate(new Date('1977-10-29T12:00:00Z')),
      expected: '2024-01',
    },
    {
      name: 'Free user (no subscription) created 3 months ago',
      subscription: undefined,
      createdAt: Timestamp.fromDate(new Date('2024-12-15T12:00:00Z')),
      expected: '2024-01',
    },
    {
      name: 'Free user (no subscription) created Feb 14th',
      subscription: undefined,
      createdAt: Timestamp.fromDate(new Date('2024-02-16T12:00:00Z')),
      expected: '2024-01',
    },
    {
      name: 'Free user (no subscription) created Feb 16th',
      subscription: undefined,
      createdAt: Timestamp.fromDate(new Date('2024-02-16T12:00:00Z')),
      expected: '2024-01',
    },
    {
      name: 'Free user (no subscription) created Feb 28th',
      subscription: undefined,
      createdAt: Timestamp.fromDate(new Date('2024-02-28T12:00:00Z')),
      expected: '2024-01',
    },
    {
      name: 'Monthly subscription started this month',
      subscription: {
        startedAt: Timestamp.fromDate(new Date('2024-02-01T12:00:00Z')),
        interval: 'monthly' as const,
      },
      createdAt: Timestamp.fromDate(new Date('1977-10-29T12:00:00Z')),
      expected: '2024-01',
    },
    {
      name: 'Yearly subscription at exactly one year',
      subscription: {
        startedAt: Timestamp.fromDate(new Date('2023-02-29T12:00:00Z')),
        interval: 'yearly' as const,
      },
      createdAt: Timestamp.fromDate(new Date('1977-10-29T12:00:00Z')),
      expected: '2024-01',
    },
  ];

  test.each(testCases)('$name', ({ subscription, createdAt, expected }) => {
    const result = getBillingPeriodKey(subscription, createdAt);
    expect(result).toBe(expected);
  });
});
