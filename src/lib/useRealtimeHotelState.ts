import { useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import type { HotelStateKey } from '@/lib/hotel-state.functions';

/**
 * Subscribe to realtime changes on public.hotel_app_state for a given key.
 * onChange fires whenever ANOTHER client (or this one) updates that row.
 */
export function useRealtimeHotelState(
  key: HotelStateKey,
  onChange: (payload: { stateData: unknown; version: number }) => void,
) {
  useEffect(() => {
    const channel = supabase
      .channel(`hotel_app_state:${key}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'hotel_app_state',
          filter: `state_key=eq.${key}`,
        },
        (msg) => {
          const row = (msg.new ?? msg.old) as
            | { state_data?: unknown; version?: number }
            | undefined;
          if (!row) return;
          onChange({
            stateData: row.state_data,
            version: Number(row.version ?? 0),
          });
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [key, onChange]);
}
