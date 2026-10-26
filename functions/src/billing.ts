import { Timestamp } from 'firebase-admin/firestore';

export const getBillingPeriodKey = (
  subscription: { startedAt: Timestamp; interval: 'monthly' | 'yearly' | null } | undefined,
  createdAt: Timestamp,
  now: Date = new Date()
) => {
  const startDate = subscription?.startedAt?.toDate() || createdAt.toDate();

  // Get last day of current month using UTC consistently
  const lastDayOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();

  // For dates like 29th, 30th, 31st, if the current month doesn't have that many days,
  // the billing date should be the last day of the month
  const startDay = startDate.getUTCDate();
  const isLastDayOfStartMonth =
    startDay >= new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth() + 1, 0)).getUTCDate();

  // If the start date was the last day of its month, use the last day of current month
  const effectiveStartDay = isLastDayOfStartMonth ? lastDayOfMonth : Math.min(startDay, lastDayOfMonth);

  // If we haven't reached the billing day yet, use previous month
  if (now.getUTCDate() < effectiveStartDay) {
    // The first of the previous month, not today a month back: on 29 or 30 March that
    // would be 29 or 30 February, which rolls over into March and resets the period
    // two days early for an account anchored on the 31st.
    const prevMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    return `${prevMonth.getUTCFullYear()}-${String(prevMonth.getUTCMonth() + 1).padStart(2, '0')}`;
  }

  // Otherwise use current month
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
};
