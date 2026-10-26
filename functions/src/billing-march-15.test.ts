import { Timestamp } from 'firebase-admin/firestore';

import { getBillingPeriodKey } from './billing';

describe('getBillingPeriodKey', () => {
  let originalDate: DateConstructor;
  const NOW = new Date('2024-03-15T12:00:00Z');

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
      name: 'Monthly subscription started Feb 13th',
      subscription: {
        startedAt: Timestamp.fromDate(new Date('2024-02-13T12:00:00Z')),
        interval: 'monthly' as const,
      },
      createdAt: Timestamp.fromDate(new Date('1977-10-29T12:00:00Z')),
      expected: '2024-03',
    },
    {
      name: 'Monthly subscription started Feb 14th',
      subscription: {
        startedAt: Timestamp.fromDate(new Date('2024-02-14T12:00:00Z')),
        interval: 'monthly' as const,
      },
      createdAt: Timestamp.fromDate(new Date('1977-10-29T12:00:00Z')),
      expected: '2024-03',
    },
    {
      name: 'Monthly subscription started Feb 15th',
      subscription: {
        startedAt: Timestamp.fromDate(new Date('2024-02-15T12:00:00Z')),
        interval: 'monthly' as const,
      },
      createdAt: Timestamp.fromDate(new Date('1977-10-29T12:00:00Z')),
      expected: '2024-03',
    },
    {
      name: 'Monthly subscription started Feb 16th',
      subscription: {
        startedAt: Timestamp.fromDate(new Date('2024-02-16T12:00:00Z')),
        interval: 'monthly' as const,
      },
      createdAt: Timestamp.fromDate(new Date('1977-10-29T12:00:00Z')),
      expected: '2024-02',
    },
    {
      name: 'Monthly subscription started Feb 28th',
      subscription: {
        startedAt: Timestamp.fromDate(new Date('2024-02-28T12:00:00Z')),
        interval: 'monthly' as const,
      },
      createdAt: Timestamp.fromDate(new Date('1977-10-29T12:00:00Z')),
      expected: '2024-02',
    },
    {
      name: 'Monthly subscription started last day of February',
      subscription: {
        startedAt: Timestamp.fromDate(new Date('2024-02-28T12:00:00Z')),
        interval: 'monthly' as const,
      },
      createdAt: Timestamp.fromDate(new Date('1977-10-29T12:00:00Z')),
      expected: '2024-02',
    },
    {
      name: 'Monthly subscription started 2 years ago',
      subscription: {
        startedAt: Timestamp.fromDate(new Date('2022-02-15T12:00:00Z')),
        interval: 'monthly' as const,
      },
      createdAt: Timestamp.fromDate(new Date('1977-10-29T12:00:00Z')),
      expected: '2024-03',
    },
    {
      name: 'Monthly subscription started around 2 years ago',
      subscription: {
        startedAt: Timestamp.fromDate(new Date('2022-02-16T12:00:00Z')),
        interval: 'monthly' as const,
      },
      createdAt: Timestamp.fromDate(new Date('1977-10-29T12:00:00Z')),
      expected: '2024-02',
    },
    {
      name: 'Yearly subscription started 14 months ago',
      subscription: {
        startedAt: Timestamp.fromDate(new Date('2023-01-15T12:00:00Z')),
        interval: 'yearly' as const,
      },
      createdAt: Timestamp.fromDate(new Date('1977-10-29T12:00:00Z')),
      expected: '2024-03',
    },
    {
      name: 'Free user (no subscription) created 3 months ago',
      subscription: undefined,
      createdAt: Timestamp.fromDate(new Date('2024-12-15T12:00:00Z')),
      expected: '2024-03',
    },
    {
      name: 'Free user (no subscription) created Feb 14th',
      subscription: undefined,
      createdAt: Timestamp.fromDate(new Date('2024-02-16T12:00:00Z')),
      expected: '2024-02',
    },
    {
      name: 'Free user (no subscription) created Feb 16th',
      subscription: undefined,
      createdAt: Timestamp.fromDate(new Date('2024-02-16T12:00:00Z')),
      expected: '2024-02',
    },
    {
      name: 'Free user (no subscription) created Feb 28th',
      subscription: undefined,
      createdAt: Timestamp.fromDate(new Date('2024-02-28T12:00:00Z')),
      expected: '2024-02',
    },
    {
      name: 'Monthly subscription started this month',
      subscription: {
        startedAt: Timestamp.fromDate(new Date('2024-03-01T12:00:00Z')),
        interval: 'monthly' as const,
      },
      createdAt: Timestamp.fromDate(new Date('1977-10-29T12:00:00Z')),
      expected: '2024-03',
    },
    {
      name: 'Yearly subscription at exactly one year',
      subscription: {
        startedAt: Timestamp.fromDate(new Date('2023-03-15T12:00:00Z')),
        interval: 'yearly' as const,
      },
      createdAt: Timestamp.fromDate(new Date('1977-10-29T12:00:00Z')),
      expected: '2024-03',
    },
  ];

  test.each(testCases)('$name', ({ subscription, createdAt, expected }) => {
    const result = getBillingPeriodKey(subscription, createdAt);
    expect(result).toBe(expected);
  });
});
