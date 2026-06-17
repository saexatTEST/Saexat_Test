import React, { createContext, useContext, useMemo, useState, useCallback, useEffect, useRef } from 'react';
import { useServerFn } from '@tanstack/react-start';
import { ROOM_CATEGORIES, ROOMS_PER_CATEGORY, type Room, type RoomCategory } from '@/types/hotel';
import { getHotelState, setHotelState } from '@/lib/hotel-state.functions';
import { useRealtimeHotelState } from '@/lib/useRealtimeHotelState';

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

export type Residency = 'resident' | 'nonResident';

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
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const r = raw as { resident?: unknown; nonResident?: unknown };
    return { resident: toArr(r.resident), nonResident: toArr(r.nonResident) };
  }
  const arr = toArr(raw);
  return { resident: arr, nonResident: [...arr] };
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

export function sumRate(rates: Record<string, CategoryRate>, categoryId: string | undefined, residency: Residency, guestCount: number): number {
  if (!categoryId) return 0;
  const r = rates[categoryId];
  if (!r) return 0;
  return perNightFor(r[residency] ?? [], guestCount);
}

export function pickRate(rates: Record<string, CategoryRate>, categoryId: string | undefined, residency: Residency = 'resident', guestIndex = 0): number {
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
  addCategory: (input: { name: string; short: string; maxGuests: number }) => void;
  removeCategory: (id: string) => void;
  addRoom: (categoryId: string, roomNumber: number) => { ok: boolean; reason?: 'exists' | 'invalid' };
  removeRoom: (roomNumber: number) => void;
  setCategoryRate: (categoryId: string, rate: CategoryRate) => void;
}

const HotelGridContext = createContext<Ctx | null>(null);
const STORAGE_KEY = 'sayohat-hotel-grid-v1';

interface PersistedState {
  extraCategories: CategoryDef[];
  removedCategoryIds: string[];
  removedRoomNumbers: number[];
  extraRooms: Room[];
  categoryRates: Record<string, CategoryRate>;
}

function emptyState(): PersistedState {
  return { extraCategories: [], removedCategoryIds: [], removedRoomNumbers: [], extraRooms: [], categoryRates: {} };
}

function parseState(raw: unknown): PersistedState {
  if (!raw || typeof raw !== 'object') return emptyState();
  const r = raw as Partial<PersistedState>;
  return {
    extraCategories: Array.isArray(r.extraCategories) ? r.extraCategories : [],
    removedCategoryIds: Array.isArray(r.removedCategoryIds) ? r.removedCategoryIds : [],
    removedRoomNumbers: Array.isArray(r.removedRoomNumbers) ? r.removedRoomNumbers : [],
    extraRooms: Array.isArray(r.extraRooms) ? r.extraRooms : [],
    categoryRates: r.categoryRates && typeof r.categoryRates === 'object' ? r.categoryRates as Record<string, CategoryRate> : {},
  };
}

function loadLocal(): PersistedState {
  if (typeof window === 'undefined') return emptyState();
  try { return parseState(JSON.parse(window.localStorage.getItem(STORAGE_KEY) || 'null')); }
  catch { return emptyState(); }
}

export function HotelGridProvider({ children }: { children: React.ReactNode }) {
  const baseCategories = useMemo<CategoryDef[]>(
    () => ROOM_CATEGORIES.map((c) => ({ id: c.id, label: c.label, short: c.short, maxGuests: c.maxGuests })),
    [],
  );

  const initial = useRef<PersistedState>(loadLocal());
  const [state, setState] = useState<PersistedState>(initial.current);

  const getShared = useServerFn(getHotelState);
  const setShared = useServerFn(setHotelState);
  const lastVersionRef = useRef(0);
  const writeTimerRef = useRef<number | null>(null);
  const skipNextPersist = useRef(false);

  const baseRooms = useMemo<Room[]>(() => {
    const rooms: Room[] = [];
    let floor = 1;
    ROOM_CATEGORIES.forEach((cat) => {
      for (let i = 1; i <= ROOMS_PER_CATEGORY; i++) rooms.push({ number: floor * 100 + i, category: cat.id });
      floor++;
    });
    return rooms;
  }, []);

  const applyCloud = useCallback((raw: unknown, version: number) => {
    if (version <= lastVersionRef.current) return;
    lastVersionRef.current = version;
    const parsed = parseState(raw);
    const knownMax = new Map<string, number>();
    baseCategories.forEach((c) => knownMax.set(c.id, c.maxGuests));
    parsed.extraCategories.forEach((c) => knownMax.set(c.id, c.maxGuests));
    const normalized: Record<string, CategoryRate> = {};
    for (const [k, v] of Object.entries(parsed.categoryRates ?? {})) normalized[k] = normalizeRate(v, knownMax.get(k) ?? 1);
    parsed.categoryRates = normalized;
    skipNextPersist.current = true;
    setState(parsed);
    if (typeof window !== 'undefined') window.localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed));
  }, [baseCategories]);

  // Initial cloud load
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const row = await getShared({ data: { key: 'grid' } });
        if (cancelled) return;
        if (row?.stateData) { applyCloud(row.stateData, row.version); return; }
        // No cloud row yet — push local seed.
        const local = loadLocal();
        const written = await setShared({ data: { key: 'grid', stateData: local } });
        lastVersionRef.current = written.version;
      } catch { /* offline-friendly: keep local */ }
    })();
    return () => { cancelled = true; };
  }, [getShared, setShared, applyCloud]);

  // Realtime: every other tab/role gets updates instantly
  useRealtimeHotelState('grid', ({ stateData, version }) => applyCloud(stateData, version));

  // Persist (debounced) -> localStorage + cloud
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (skipNextPersist.current) { skipNextPersist.current = false; return; }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    if (writeTimerRef.current) window.clearTimeout(writeTimerRef.current);
    writeTimerRef.current = window.setTimeout(() => {
      void setShared({ data: { key: 'grid', stateData: state } })
        .then((row) => { lastVersionRef.current = row.version; })
        .catch(() => undefined);
    }, 120);
  }, [state, setShared]);

  const categories = useMemo(() => {
    const removed = new Set(state.removedCategoryIds);
    return [...baseCategories, ...state.extraCategories].filter((c) => !removed.has(c.id));
  }, [baseCategories, state.extraCategories, state.removedCategoryIds]);

  const rooms = useMemo<Room[]>(() => {
    const removedRooms = new Set(state.removedRoomNumbers);
    const removedCats = new Set(state.removedCategoryIds);
    const visibleBase = baseRooms.filter((r) => !removedRooms.has(r.number) && !removedCats.has(r.category));
    return [...visibleBase, ...state.extraRooms.filter((r) => !removedCats.has(r.category))].sort((a, b) => a.number - b.number);
  }, [baseRooms, state.removedRoomNumbers, state.removedCategoryIds, state.extraRooms]);

  const addCategory = useCallback(({ name, short, maxGuests }: { name: string; short: string; maxGuests: number }) => {
    const id = `custom-${Date.now()}`;
    setState((prev) => ({
      ...prev,
      extraCategories: [...prev.extraCategories, {
        id, custom: true,
        short: short.trim() || name.slice(0, 6).toUpperCase(),
        maxGuests: Math.max(1, Math.floor(maxGuests || 1)),
        label: { ru: name, uz: name, en: name },
      }],
    }));
  }, []);

  const removeCategory = useCallback((id: string) => {
    setState((prev) => ({
      ...prev,
      removedCategoryIds: Array.from(new Set([...prev.removedCategoryIds, id])),
      extraCategories: prev.extraCategories.filter((c) => c.id !== id),
      extraRooms: prev.extraRooms.filter((r) => r.category !== id),
    }));
  }, []);

  const addRoom = useCallback((categoryId: string, roomNumber: number) => {
    if (!Number.isFinite(roomNumber) || roomNumber <= 0) return { ok: false, reason: 'invalid' as const };
    const removedRooms = new Set(state.removedRoomNumbers);
    const all = new Set([...baseRooms.map((r) => r.number), ...state.extraRooms.map((r) => r.number)]);
    if (all.has(roomNumber) && !removedRooms.has(roomNumber)) return { ok: false, reason: 'exists' as const };
    setState((prev) => ({
      ...prev,
      extraRooms: [...prev.extraRooms, { number: roomNumber, category: categoryId as RoomCategory }],
      removedRoomNumbers: prev.removedRoomNumbers.filter((n) => n !== roomNumber),
    }));
    return { ok: true };
  }, [baseRooms, state.extraRooms, state.removedRoomNumbers]);

  const removeRoom = useCallback((roomNumber: number) => {
    setState((prev) => ({
      ...prev,
      extraRooms: prev.extraRooms.filter((r) => r.number !== roomNumber),
      removedRoomNumbers: Array.from(new Set([...prev.removedRoomNumbers, roomNumber])),
    }));
  }, []);

  const setCategoryRate = useCallback((categoryId: string, rate: CategoryRate) => {
    const maxG =
      baseCategories.find((c) => c.id === categoryId)?.maxGuests ??
      state.extraCategories.find((c) => c.id === categoryId)?.maxGuests ??
      Math.max(rate.resident?.length ?? 0, rate.nonResident?.length ?? 0, 1);
    setState((prev) => ({
      ...prev,
      categoryRates: { ...prev.categoryRates, [categoryId]: normalizeRate(rate, maxG) },
    }));
  }, [baseCategories, state.extraCategories]);

  const value: Ctx = {
    categories, rooms, categoryRates: state.categoryRates,
    addCategory, removeCategory, addRoom, removeRoom, setCategoryRate,
  };
  return <HotelGridContext.Provider value={value}>{children}</HotelGridContext.Provider>;
}

export function useHotelGrid() {
  const ctx = useContext(HotelGridContext);
  if (!ctx) throw new Error('useHotelGrid must be used inside HotelGridProvider');
  return ctx;
}
