import { useState, useCallback, useEffect, useRef } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Booking, generateSampleBookings } from "@/types/hotel";
import {
  differenceInCalendarDays,
  isBefore,
  parseISO,
  startOfDay,
} from "date-fns";
import { toast } from "sonner";
import { getHotelState, setHotelState } from "@/lib/hotel-state.functions";
import { useRealtimeHotelState } from "@/lib/useRealtimeHotelState";
import { useI18n } from "./useI18n";

const STORAGE_KEY = "sayohat-bookings-v2";
const CHANGE_EVENT = "sayohat-bookings-changed";
const CLOUD_WRITE_DEBOUNCE_MS = 120;

function bookingSignature(b: Booking): string {
  return [
    b.roomNumber,
    b.bedIndex ?? "room",
    b.checkIn,
    b.checkOut,
    b.status,
    (b.guestName || "").trim().toLowerCase(),
  ].join("|");
}

function isLegacySampleBooking(b: Booking): boolean {
  return /^b\d+$/.test(String(b.id));
}

function normalizeBookings(input: unknown): Booking[] {
  if (!Array.isArray(input)) return [];

  const byId = new Map<string, Booking>();
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const b = item as Booking;
    if (!b.id || !b.roomNumber || !b.checkIn || !b.checkOut || !b.status) continue;
    if (isLegacySampleBooking(b)) continue;
    byId.set(String(b.id), b);
  }

  const bySignature = new Map<string, Booking>();
  for (const b of byId.values()) bySignature.set(bookingSignature(b), b);

  return applyAutoCheckout(Array.from(bySignature.values()));
}

function loadLocalBookings(): Booking[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return normalizeBookings(JSON.parse(raw));
  } catch {
    return [];
  }
}

function saveLocalBookings(bookings: Booking[]) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(bookings));
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function bookingHalfSpan(b: Booking): [number, number] {
  const base = startOfDay(parseISO("2000-01-01"));
  const inDay = differenceInCalendarDays(parseISO(b.checkIn), base);
  const outDay = differenceInCalendarDays(parseISO(b.checkOut), base);
  return [
    2 * inDay + 1 - (b.checkInHalfDay ? 1 : 0),
    2 * outDay + 1 + (b.checkOutHalfDay ? 1 : 0),
  ];
}

function bookingsConflict(a: Booking, b: Booking): boolean {
  if (a.id === b.id) return false;
  if (a.roomNumber !== b.roomNumber) return false;

  const eitherIsRoomWide =
    a.status === "maintenance" ||
    b.status === "maintenance" ||
    a.bedIndex === undefined ||
    b.bedIndex === undefined;

  if (!eitherIsRoomWide) {
    const aBeds = new Set<number>([a.bedIndex as number, ...(a.additionalBeds ?? [])]);
    const bBeds = new Set<number>([b.bedIndex as number, ...(b.additionalBeds ?? [])]);
    let overlap = false;
    for (const bed of aBeds) {
      if (bBeds.has(bed)) { overlap = true; break; }
    }
    if (!overlap) return false;
  }

  const [aStart, aEnd] = bookingHalfSpan(a);
  const [bStart, bEnd] = bookingHalfSpan(b);
  return aStart < bEnd && bStart < aEnd;
}

function findConflict(list: Booking[], candidate: Booking): Booking | undefined {
  return list.find((b) => bookingsConflict(b, candidate));
}

function applyAutoCheckout(list: Booking[]): Booking[] {
  const today = startOfDay(new Date());
  let changed = false;
  const next = list.map((b) => {
    if (b.status === "maintenance" || b.status === "checked-out") return b;
    const out = parseISO(b.checkOut);
    if (isBefore(out, today)) {
      changed = true;
      return { ...b, status: "checked-out" as const };
    }
    return b;
  });
  return changed ? next : list;
}

export function useBookings() {
  const { t } = useI18n();
  const getSharedState = useServerFn(getHotelState);
  const setSharedState = useServerFn(setHotelState);

  const [bookings, setBookings] = useState<Booking[]>([]);

  const lastCloudVersionRef = useRef(0);
  const cloudWriteTimerRef = useRef<number | null>(null);
  const pendingWriteRef = useRef(false);

  const pushCloud = useCallback(
    (next: Booking[]) => {
      if (typeof window === "undefined") return;
      if (cloudWriteTimerRef.current) window.clearTimeout(cloudWriteTimerRef.current);
      pendingWriteRef.current = true;
      cloudWriteTimerRef.current = window.setTimeout(() => {
        void setSharedState({ data: { key: "bookings", stateData: next } })
          .then((row) => {
            lastCloudVersionRef.current = Math.max(
              lastCloudVersionRef.current,
              Number(row.version ?? 0),
            );
          })
          .catch(() => undefined)
          .finally(() => {
            cloudWriteTimerRef.current = null;
            pendingWriteRef.current = false;
          });
      }, CLOUD_WRITE_DEBOUNCE_MS);
    },
    [setSharedState],
  );

  const persist = useCallback(
    (nextRaw: Booking[]) => {
      const next = normalizeBookings(nextRaw);
      saveLocalBookings(next);
      pushCloud(next);
      return next;
    },
    [pushCloud],
  );

  // Initial load: localStorage first (fast), then cloud (authoritative).
  useEffect(() => {
    if (typeof window === "undefined") return;

    const local = loadLocalBookings();
    const initial =
      local.length > 0 ? local : normalizeBookings(generateSampleBookings());
    setBookings(initial);
    saveLocalBookings(initial);

    let cancelled = false;
    (async () => {
      try {
        const row = await getSharedState({ data: { key: "bookings" } });
        if (cancelled) return;

        if (row?.stateData) {
          const rowVersion = Number(row.version ?? 0);
          if (rowVersion > lastCloudVersionRef.current) {
            lastCloudVersionRef.current = rowVersion;
            const next = normalizeBookings(row.stateData);
            setBookings(next);
            saveLocalBookings(next);
          }
          return;
        }

        // No cloud row yet → seed it from whatever we have locally.
        const seed = loadLocalBookings();
        const saved = await setSharedState({
          data: { key: "bookings", stateData: seed },
        });
        lastCloudVersionRef.current = Number(saved.version ?? 0);
      } catch {
        // offline-friendly: keep local state
      }
    })();

    return () => {
      cancelled = true;
      if (cloudWriteTimerRef.current) window.clearTimeout(cloudWriteTimerRef.current);
    };
  }, [getSharedState, setSharedState]);

  // Realtime: instant push from any other user/tab. Replaces 1s polling.
  useRealtimeHotelState("bookings", ({ stateData, version }) => {
    // Ignore echoes of our own pending write or stale versions.
    if (pendingWriteRef.current) return;
    if (version <= lastCloudVersionRef.current) return;
    lastCloudVersionRef.current = version;
    const next = normalizeBookings(stateData);
    setBookings(next);
    saveLocalBookings(next);
  });

  // Auto-checkout sweep (daily rollovers).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const tick = () => {
      setBookings((prev) => {
        const next = applyAutoCheckout(prev);
        if (next !== prev) {
          saveLocalBookings(next);
          pushCloud(next);
        }
        return next;
      });
    };
    const id = window.setInterval(tick, 60_000);
    return () => window.clearInterval(id);
  }, [pushCloud]);

  // Cross-tab sync (same browser): mirrors localStorage between tabs.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const reload = () => setBookings(loadLocalBookings());
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) reload();
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener(CHANGE_EVENT, reload as EventListener);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(CHANGE_EVENT, reload as EventListener);
    };
  }, []);

  const addBooking = useCallback(
    (booking: Booking) => {
      let rejected = false;
      setBookings((prev) => {
        const conflict = findConflict(prev, booking);
        if (conflict) {
          rejected = true;
          toast.error(t("overlapError"));
          return prev;
        }
        return persist([...prev, booking]);
      });
      return !rejected;
    },
    [persist, t],
  );

  const removeBooking = useCallback(
    (id: string) => {
      setBookings((prev) => persist(prev.filter((b) => b.id !== id)));
    },
    [persist],
  );

  const updateBooking = useCallback(
    (id: string, updates: Partial<Booking>) => {
      let rejected = false;
      setBookings((prev) => {
        const target = prev.find((b) => b.id === id);
        if (!target) return prev;
        const candidate: Booking = { ...target, ...updates };
        const conflict = findConflict(prev, candidate);
        if (conflict) {
          rejected = true;
          toast.error(t("overlapError"));
          return prev;
        }
        return persist(prev.map((b) => (b.id === id ? candidate : b)));
      });
      return !rejected;
    },
    [persist, t],
  );

  return { bookings, addBooking, removeBooking, updateBooking };
}
