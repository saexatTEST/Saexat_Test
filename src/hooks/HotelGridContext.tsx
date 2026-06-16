import React, {
  createContext,
  useContext,
  useMemo,
  useState,
  useCallback,
  useEffect,
  useRef,
} from "react";
import { useServerFn } from "@tanstack/react-start";
import {
  ROOM_CATEGORIES,
  ROOMS_PER_CATEGORY,
  type Room,
  type RoomCategory,
} from "@/types/hotel";
import { getHotelState, setHotelState } from "@/lib/hotel-state.functions";

export interface CategoryDef {
  id: string;
  label: Record<string, string>;
  short: string;
  maxGuests: number;
  custom?: boolean;
}

export interface CategoryRate {
  resident: number[];
  nonResident: number[];
}

export type Residency = "resident" | "nonResident";

export function normalizeRate(raw: unknown, maxGuests = 1): CategoryRate {
  const slots = Math.max(1, Math.floor(maxGuests || 1));

  const toArr = (v: unknown): number[] => {
    if (Array.isArray(v)) {
      const arr = v.map((x) => Math.max(0, Number(x) || 0));

      if (arr.length >= slots) return arr.slice(0, slots);

      const fill = arr[arr.length - 1] ?? 0;

      return [...arr, ...Array.from({ length: slots - arr.length }, () => fill)];
    }

    const n = Math.max(0, Number(v) || 0);

    return Array.from({ length: slots }, () => n);
  };

  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const r = raw as {
      resident?: unknown;
      nonResident?: unknown;
    };

    return {
      resident: toArr(r.resident),
      nonResident: toArr(r.nonResident),
    };
  }

  const arr = toArr(raw);

  return {
    resident: arr,
    nonResident: [...arr],
  };
}

export function perNightFor(arr: number[] | undefined, guestCount: number): number {
  if (!arr || arr.length === 0) return 0;

  const n = Math.max(0, Math.floor(guestCount || 0));
  if (n === 0) return 0;

  const maxG = arr.length;
  const within = Math.min(n, maxG);
  const base = Number(arr[within - 1]) || 0;
  const extras = Math.max(0, n - maxG);
  const extraRate = Number(arr[0]) || 0;

  return base + extras * extraRate;
}

export function sumRate(
  rates: Record<string, CategoryRate>,
  categoryId: string | undefined,
  residency: Residency,
  guestCount: number,
): number {
  if (!categoryId) return 0;

  const r = rates[categoryId];
  if (!r) return 0;

  return perNightFor(r[residency] ?? [], guestCount);
}

export function pickRate(
  rates: Record<string, CategoryRate>,
  categoryId: string | undefined,
  residency: Residency = "resident",
  guestIndex = 0,
): number {
  if (!categoryId) return 0;

  const r = rates[categoryId];
  if (!r) return 0;

  const arr = r[residency] ?? [];

  return Number(arr[guestIndex]) || 0;
}

interface Ctx {
  categories: CategoryDef[];
  rooms: Room[];
  categoryRates: Record<string, CategoryRate>;
  addCategory: (input: {
    name: string;
    short: string;
    maxGuests: number;
  }) => void;
  removeCategory: (id: string) => void;
  addRoom: (
    categoryId: string,
    roomNumber: number,
  ) => {
    ok: boolean;
    reason?: "exists" | "invalid";
  };
  removeRoom: (roomNumber: number) => void;
  setCategoryRate: (categoryId: string, rate: CategoryRate) => void;
}

const HotelGridContext = createContext<Ctx | null>(null);

const STORAGE_KEY = "sayohat-hotel-grid-v1";
const CHANGE_EVENT = "sayohat-hotel-grid-changed";
const CLOUD_POLL_MS = 1000;
const CLOUD_WRITE_DEBOUNCE_MS = 120;

interface PersistedState {
  extraCategories: CategoryDef[];
  removedCategoryIds: string[];
  removedRoomNumbers: number[];
  extraRooms: Room[];
  categoryRates?: Record<string, CategoryRate>;
}

function emptyPersistedState(): PersistedState {
  return {
    extraCategories: [],
    removedCategoryIds: [],
    removedRoomNumbers: [],
    extraRooms: [],
    categoryRates: {},
  };
}

function cleanPersistedState(input: unknown): PersistedState {
  if (!input || typeof input !== "object") return emptyPersistedState();

  const parsed = input as Partial<PersistedState>;

  return {
    extraCategories: Array.isArray(parsed.extraCategories)
      ? parsed.extraCategories
      : [],
    removedCategoryIds: Array.isArray(parsed.removedCategoryIds)
      ? parsed.removedCategoryIds
      : [],
    removedRoomNumbers: Array.isArray(parsed.removedRoomNumbers)
      ? parsed.removedRoomNumbers
      : [],
    extraRooms: Array.isArray(parsed.extraRooms) ? parsed.extraRooms : [],
    categoryRates:
      parsed.categoryRates && typeof parsed.categoryRates === "object"
        ? parsed.categoryRates
        : {},
  };
}

function loadPersisted(): PersistedState | null {
  if (typeof window === "undefined") return null;

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;

    return cleanPersistedState(JSON.parse(raw));
  } catch {
    return null;
  }
}

function savePersisted(payload: PersistedState) {
  if (typeof window === "undefined") return;

  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function normalizeCategoryRates(
  payload: PersistedState,
  baseCategories: CategoryDef[],
): Record<string, CategoryRate> {
  const knownMax = new Map<string, number>();

  baseCategories.forEach((c) => knownMax.set(c.id, c.maxGuests));
  payload.extraCategories.forEach((c) => knownMax.set(c.id, c.maxGuests));

  const normalized: Record<string, CategoryRate> = {};

  for (const [k, v] of Object.entries(payload.categoryRates ?? {})) {
    normalized[k] = normalizeRate(v, knownMax.get(k) ?? 1);
  }

  return normalized;
}

export function HotelGridProvider({ children }: { children: React.ReactNode }) {
  const getSharedState = useServerFn(getHotelState);
  const setSharedState = useServerFn(setHotelState);

  const baseCategories = useMemo<CategoryDef[]>(
    () =>
      ROOM_CATEGORIES.map((c) => ({
        id: c.id,
        label: c.label,
        short: c.short,
        maxGuests: c.maxGuests,
      })),
    [],
  );

  const initial = useRef<PersistedState | null>(loadPersisted());

  const [extraCategories, setExtraCategories] = useState<CategoryDef[]>(
    initial.current?.extraCategories ?? [],
  );

  const [removedCategoryIds, setRemovedCategoryIds] = useState<Set<string>>(
    new Set(initial.current?.removedCategoryIds ?? []),
  );

  const [removedRoomNumbers, setRemovedRoomNumbers] = useState<Set<number>>(
    new Set(initial.current?.removedRoomNumbers ?? []),
  );

  const [extraRooms, setExtraRooms] = useState<Room[]>(
    initial.current?.extraRooms ?? [],
  );

  const [categoryRates, setCategoryRates] = useState<Record<string, CategoryRate>>(
    () => normalizeCategoryRates(initial.current ?? emptyPersistedState(), baseCategories),
  );

  const baseRooms = useMemo<Room[]>(() => {
    const rooms: Room[] = [];
    let floor = 1;

    ROOM_CATEGORIES.forEach((cat) => {
      for (let i = 1; i <= ROOMS_PER_CATEGORY; i++) {
        rooms.push({
          number: floor * 100 + i,
          category: cat.id,
        });
      }

      floor++;
    });

    return rooms;
  }, []);

  const lastCloudVersionRef = useRef(0);
  const cloudWriteTimerRef = useRef<number | null>(null);
  const readyToPersistRef = useRef(false);
  const skipNextPersistRef = useRef(false);

  const makePayload = useCallback(
    (): PersistedState => ({
      extraCategories,
      removedCategoryIds: Array.from(removedCategoryIds),
      removedRoomNumbers: Array.from(removedRoomNumbers),
      extraRooms,
      categoryRates,
    }),
    [
      extraCategories,
      removedCategoryIds,
      removedRoomNumbers,
      extraRooms,
      categoryRates,
    ],
  );

  const applyPayload = useCallback(
    (raw: unknown) => {
      const payload = cleanPersistedState(raw);

      skipNextPersistRef.current = true;

      setExtraCategories(payload.extraCategories);
      setRemovedCategoryIds(new Set(payload.removedCategoryIds));
      setRemovedRoomNumbers(new Set(payload.removedRoomNumbers));
      setExtraRooms(payload.extraRooms);
      setCategoryRates(normalizeCategoryRates(payload, baseCategories));

      savePersisted(payload);
    },
    [baseCategories],
  );

  useEffect(() => {
    if (typeof window === "undefined") return;

    let cancelled = false;

    const loadCloud = async () => {
      try {
        const row = await getSharedState({
          data: {
            key: "grid",
          },
        });

        if (cancelled) return;

        if (row?.stateData) {
          const rowVersion = Number(row.version ?? 0);

          if (
            rowVersion > lastCloudVersionRef.current &&
            !cloudWriteTimerRef.current
          ) {
            lastCloudVersionRef.current = rowVersion;
            applyPayload(row.stateData);
          }

          readyToPersistRef.current = true;
          return;
        }

        const seed = loadPersisted() ?? makePayload();

        const saved = await setSharedState({
          data: {
            key: "grid",
            stateData: seed,
          },
        });

        lastCloudVersionRef.current = Number(saved.version ?? 0);
        readyToPersistRef.current = true;
      } catch {
        readyToPersistRef.current = true;
      }
    };

    void loadCloud();

    const id = window.setInterval(loadCloud, CLOUD_POLL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(id);

      if (cloudWriteTimerRef.current) {
        window.clearTimeout(cloudWriteTimerRef.current);
      }
    };
  }, [getSharedState, setSharedState, applyPayload, makePayload]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    if (!readyToPersistRef.current) return;

    if (skipNextPersistRef.current) {
      skipNextPersistRef.current = false;
      return;
    }

    const payload = makePayload();

    savePersisted(payload);

    if (cloudWriteTimerRef.current) {
      window.clearTimeout(cloudWriteTimerRef.current);
    }

    cloudWriteTimerRef.current = window.setTimeout(() => {
      void setSharedState({
        data: {
          key: "grid",
          stateData: payload,
        },
      })
        .then((row) => {
          lastCloudVersionRef.current = Math.max(
            lastCloudVersionRef.current,
            Number(row.version ?? 0),
          );
        })
        .catch(() => undefined)
        .finally(() => {
          cloudWriteTimerRef.current = null;
        });
    }, CLOUD_WRITE_DEBOUNCE_MS);
  }, [makePayload, setSharedState]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const reload = () => {
      const data = loadPersisted();
      if (!data) return;

      skipNextPersistRef.current = true;

      setExtraCategories(data.extraCategories);
      setRemovedCategoryIds(new Set(data.removedCategoryIds));
      setRemovedRoomNumbers(new Set(data.removedRoomNumbers));
      setExtraRooms(data.extraRooms);
      setCategoryRates(normalizeCategoryRates(data, baseCategories));
    };

    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) reload();
    };

    window.addEventListener("storage", onStorage);
    window.addEventListener(CHANGE_EVENT, reload as EventListener);

    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(CHANGE_EVENT, reload as EventListener);
    };
  }, [baseCategories]);

  const categories = useMemo(
    () =>
      [...baseCategories, ...extraCategories].filter(
        (category) => !removedCategoryIds.has(category.id),
      ),
    [baseCategories, extraCategories, removedCategoryIds],
  );

  const rooms = useMemo<Room[]>(() => {
    const visibleBase = baseRooms.filter(
      (r) => !removedRoomNumbers.has(r.number) && !removedCategoryIds.has(r.category),
    );

    const merged = [
      ...visibleBase,
      ...extraRooms.filter((r) => !removedCategoryIds.has(r.category)),
    ];

    return merged.sort((a, b) => a.number - b.number);
  }, [baseRooms, removedRoomNumbers, extraRooms, removedCategoryIds]);

  const addCategory = useCallback(
    ({
      name,
      short,
      maxGuests,
    }: {
      name: string;
      short: string;
      maxGuests: number;
    }) => {
      const id = `custom-${Date.now()}`;

      setExtraCategories((prev) => [
        ...prev,
        {
          id,
          custom: true,
          short: short.trim() || name.slice(0, 6).toUpperCase(),
          maxGuests: Math.max(1, Math.floor(maxGuests || 1)),
          label: {
            ru: name,
            uz: name,
            en: name,
          },
        },
      ]);
    },
    [],
  );

  const removeCategory = useCallback((id: string) => {
    setRemovedCategoryIds((prev) => new Set(prev).add(id));
    setExtraCategories((prev) => prev.filter((c) => c.id !== id));
    setExtraRooms((prev) => prev.filter((r) => r.category !== id));
  }, []);

  const addRoom = useCallback(
    (categoryId: string, roomNumber: number) => {
      if (!Number.isFinite(roomNumber) || roomNumber <= 0) {
        return {
          ok: false,
          reason: "invalid" as const,
        };
      }

      const allNumbers = new Set([
        ...baseRooms.map((r) => r.number),
        ...extraRooms.map((r) => r.number),
      ]);

      if (allNumbers.has(roomNumber) && !removedRoomNumbers.has(roomNumber)) {
        return {
          ok: false,
          reason: "exists" as const,
        };
      }

      setExtraRooms((prev) => [
        ...prev,
        {
          number: roomNumber,
          category: categoryId as RoomCategory,
        },
      ]);

      setRemovedRoomNumbers((prev) => {
        if (!prev.has(roomNumber)) return prev;

        const n = new Set(prev);
        n.delete(roomNumber);

        return n;
      });

      return {
        ok: true,
      };
    },
    [baseRooms, extraRooms, removedRoomNumbers],
  );

  const removeRoom = useCallback((roomNumber: number) => {
    setExtraRooms((prev) => prev.filter((r) => r.number !== roomNumber));
    setRemovedRoomNumbers((prev) => new Set(prev).add(roomNumber));
  }, []);

  const setCategoryRate = useCallback(
    (categoryId: string, rate: CategoryRate) => {
      const maxG =
        baseCategories.find((c) => c.id === categoryId)?.maxGuests ??
        extraCategories.find((c) => c.id === categoryId)?.maxGuests ??
        Math.max(
          (rate.resident as number[] | undefined)?.length ?? 0,
          (rate.nonResident as number[] | undefined)?.length ?? 0,
          1,
        );

      setCategoryRates((prev) => ({
        ...prev,
        [categoryId]: normalizeRate(rate, maxG),
      }));
    },
    [baseCategories, extraCategories],
  );

  const value: Ctx = {
    categories,
    rooms,
    categoryRates,
    addCategory,
    removeCategory,
    addRoom,
    removeRoom,
    setCategoryRate,
  };

  return (
    <HotelGridContext.Provider value={value}>
      {children}
    </HotelGridContext.Provider>
  );
}

export function useHotelGrid() {
  const ctx = useContext(HotelGridContext);

  if (!ctx) {
    throw new Error("useHotelGrid must be used inside HotelGridProvider");
  }

  return ctx;
}
