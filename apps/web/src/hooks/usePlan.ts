import { useCallback, useEffect, useRef, useState } from 'react';

import { useAuth } from '@/contexts/AuthContext';
import { PlanReport, errorText, planApi } from '@/services/plan';

/**
 * The signed-in account's plan, read once per mount and again on demand. `plan` is
 * undefined while it is being read; `error` says why it could not be.
 *
 * A read that started before a later `setPlan` is dropped when it lands: back from a
 * checkout, the mount's `getPlan` and the first `refreshSubscription` start together,
 * and the one that reads the document before the webhook has landed would otherwise
 * put a Free report over the Pro one the settle had just set.
 */
export function usePlan() {
  const { user } = useAuth();
  const [plan, setPlanState] = useState<PlanReport | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);

  const setPlan = useCallback((next: PlanReport) => {
    sequence.current++;
    setPlanState(next);
  }, []);

  // Answers what it read, even a read a later one has overtaken: the caller asked about the
  // plan as it stands now, and only the state is kept from going backwards.
  const refresh = useCallback(async (): Promise<PlanReport | undefined> => {
    if (!user) return undefined;
    const mine = ++sequence.current;
    try {
      const read = await planApi.getPlan();
      if (mine === sequence.current) {
        setPlanState(read);
        setError(null);
      }
      return read;
    } catch (err) {
      if (mine === sequence.current) setError(errorText(err, 'Your plan could not be read right now.'));
      return undefined;
    }
  }, [user]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { plan, error, refresh, setPlan };
}
